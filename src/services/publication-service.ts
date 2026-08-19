import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { Article } from "../domain/article.js";
import { articleContentHash, booleanCell, dateCell, stringCell } from "../domain/article.js";
import { assertTransition } from "../domain/transitions.js";
import type { GhostAdminClient, GhostPost } from "../ghost/client.js";
import { buildGhostPayload, ghostArticleSlug, publicArticleUrl } from "../ghost/payload.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";

export class PublicationService {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly ghost: GhostAdminClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly mutex: KeyedMutex,
  ) {}

  async runOnce(): Promise<void> {
    const settings = await this.store.getSettings();
    if (!this.#publishingIsEnabled(settings)) return;
    const candidates = await this.store.listArticles(["approved", "scheduled", "publishing"]);
    const timeZone = stringCell(asCell(settings.get("timezone"))) || "Europe/Belgrade";
    for (const candidate of candidates) {
      try {
        await this.mutex.runExclusive(candidate.article_id, () =>
          candidate.status === "publishing"
            ? this.#recoverPublishing(candidate.article_id, timeZone)
            : this.#process(candidate.article_id, timeZone),
        );
      } catch (error) {
        this.logger.error(
          { articleId: candidate.article_id, err: error instanceof Error ? error.message : String(error) },
          "Publication candidate failed before claim",
        );
      }
    }
  }

  #publishingIsEnabled(settings: Map<string, unknown>): boolean {
    return publicationIsEnabled(this.config, settings);
  }

  async #process(articleId: string, timeZone: string): Promise<void> {
    const article = await this.store.findArticle(articleId);
    if (!article || !["approved", "scheduled"].includes(article.status)) return;
    const scheduledAt = parseScheduledDate(article, timeZone);
    if (article.status === "approved" && scheduledAt && scheduledAt.getTime() > Date.now()) {
      assertTransition("approved", "scheduled");
      const now = new Date().toISOString();
      await this.store.patchArticle(article.article_id, { status: "scheduled", updated_at: now });
      await this.#event(article, "scheduled", "approved", "scheduled", "Scheduled for publication", {
        scheduled_at: scheduledAt.toISOString(),
      });
      return;
    }
    if (article.status === "scheduled" && scheduledAt && scheduledAt.getTime() > Date.now()) return;

    const currentHash = articleContentHash(article);
    const approvedHash = await this.#latestApprovedHash(article.article_id);
    if (!approvedHash || approvedHash !== currentHash || stringCell(article.content_hash) !== currentHash) {
      await this.#markConflict(article, currentHash, approvedHash);
      return;
    }

    assertTransition(article.status, "publishing");
    const startedAt = new Date().toISOString();
    await this.store.patchArticle(article.article_id, {
      status: "publishing",
      last_error: "",
      updated_at: startedAt,
    });
    await this.#event(article, "publishing_started", article.status, "publishing", "Publishing to Ghost", {
      hash: currentHash,
    });

    try {
      const claimed = await this.store.findArticle(article.article_id);
      if (!claimed || claimed.status !== "publishing") return;
      if (articleContentHash(claimed) !== currentHash) {
        await this.#setConflict(claimed, "changed_during_publish", "Article changed after publication claim", {
          claimed_hash: currentHash,
          current_hash: articleContentHash(claimed),
        });
        return;
      }
      const published = await this.#upsertAndPublish(claimed, currentHash);
      await this.#finalizePublished(claimed, published, currentHash);
    } catch (error) {
      const message = sanitizeError(error);
      this.logger.error({ articleId: article.article_id, err: message }, "Ghost publication failed");
      const latest = await this.store.findArticle(article.article_id);
      if (!latest || latest.status !== "publishing") return;
      const now = new Date().toISOString();
      await this.store.patchArticle(article.article_id, {
        status: "failed_publish",
        last_error: message,
        updated_at: now,
      });
      await this.#event(article, "publish_failed", "publishing", "failed_publish", message);
    }
  }

  async #upsertAndPublish(article: Article, expectedHash: string): Promise<GhostPost> {
    const expectedSlug = ghostArticleSlug(article);
    const storedId = stringCell(article.ghost_post_id);
    let post: GhostPost | undefined;
    if (storedId) {
      post = await this.ghost.readPost(storedId);
      if (!post) throw new Error(`Stored Ghost post ${storedId} no longer exists`);
      if (post.slug !== expectedSlug) throw new Error(`Ghost slug conflict for stored post ${storedId}`);
    } else {
      const collision = await this.ghost.findPostBySlug(expectedSlug);
      if (collision) throw new Error(`Ghost slug already exists without matching ghost_post_id: ${expectedSlug}`);
      const draftPayload = await buildGhostPayload(article, "draft");
      const currentUser = await this.ghost.readCurrentUser();
      if (currentUser) draftPayload.authors = [{ id: currentUser.id }];
      post = await this.ghost.createPost(draftPayload);
      await this.store.patchArticle(article.article_id, {
        ghost_post_id: post.id,
        ghost_updated_at: post.updated_at,
        ghost_draft_url: post.url,
        updated_at: new Date().toISOString(),
      });
    }

    const fresh = await this.ghost.readPost(post.id);
    if (!fresh) throw new Error(`Ghost post disappeared before publish: ${post.id}`);
    const publishPayload = await buildGhostPayload(article, "published");
    const currentSheetArticle = await this.store.findArticle(article.article_id);
    if (
      !currentSheetArticle ||
      currentSheetArticle.status !== "publishing" ||
      articleContentHash(currentSheetArticle) !== expectedHash
    ) {
      throw new Error("Publication claim was changed before Ghost publish");
    }
    return this.ghost.updatePost(post.id, {
      ...publishPayload,
      updated_at: fresh.updated_at,
    });
  }

  async #recoverPublishing(articleId: string, timeZone: string): Promise<void> {
    const article = await this.store.findArticle(articleId);
    if (!article || article.status !== "publishing") return;
    const claimedAt = dateCell(article.updated_at, timeZone);
    const staleAfterMs = Math.max(this.config.pollIntervalMs * 4, 5 * 60_000);
    if (claimedAt && Date.now() - claimedAt.getTime() < staleAfterMs) return;

    const currentHash = articleContentHash(article);
    const approvedHash = await this.#latestApprovedHash(article.article_id);
    if (!approvedHash || approvedHash !== currentHash || stringCell(article.content_hash) !== currentHash) {
      await this.#markConflict(article, currentHash, approvedHash);
      return;
    }
    const storedId = stringCell(article.ghost_post_id);
    if (!storedId) {
      const collision = await this.ghost.findPostBySlug(ghostArticleSlug(article));
      if (collision) {
        await this.#setConflict(
          article,
          "ghost_slug_collision",
          "A Ghost post exists after a stale claim but is not bound by ghost_post_id",
          { ghost_post_id: collision.id, ghost_status: collision.status },
        );
        return;
      }
      assertTransition("publishing", "approved");
      await this.store.patchArticle(article.article_id, {
        status: "approved",
        last_error: "Recovered stale publishing claim before Ghost create",
        updated_at: new Date().toISOString(),
      });
      await this.#event(
        article,
        "publishing_recovered",
        "publishing",
        "approved",
        "Stale claim reset for safe retry",
      );
      return;
    }

    const ghostPost = await this.ghost.readPost(storedId);
    if (!ghostPost) {
      await this.#failPublishing(article, `Stored Ghost post ${storedId} no longer exists`);
      return;
    }
    try {
      const published =
        ghostPost.status === "published"
          ? ghostPost
          : await this.#upsertAndPublish(article, currentHash);
      await this.#finalizePublished(article, published, currentHash);
    } catch (error) {
      await this.#failPublishing(article, sanitizeError(error));
    }
  }

  async #finalizePublished(article: Article, published: GhostPost, currentHash: string): Promise<void> {
    const settings = await this.store.getSettings();
    const baseUrlKey = `${this.config.targetEnvironment}_frontend_base_url`;
    const frontendBaseUrl = stringCell(asCell(settings.get(baseUrlKey)));
    if (!frontendBaseUrl) throw new Error(`Missing setting ${baseUrlKey}`);
    const publicUrl = publicArticleUrl(frontendBaseUrl, article);
    const verification = await verifyPublicPage(publicUrl);
    const now = new Date().toISOString();
    await this.store.patchArticle(article.article_id, {
      status: "published",
      ghost_post_id: published.id,
      ghost_updated_at: published.updated_at,
      ghost_draft_url: published.url,
      public_url: publicUrl,
      published_at: published.published_at ?? now,
      last_error: verification.ok ? "" : verification.message,
      updated_at: now,
    });
    await this.#event(article, "published", "publishing", "published", "Published to Ghost", {
      hash: currentHash,
      ghost_post_id: published.id,
      public_url: publicUrl,
      verification,
    });
  }

  async #failPublishing(article: Article, message: string): Promise<void> {
    const current = await this.store.findArticle(article.article_id);
    if (!current || current.status !== "publishing") return;
    assertTransition("publishing", "failed_publish");
    await this.store.patchArticle(article.article_id, {
      status: "failed_publish",
      last_error: message,
      updated_at: new Date().toISOString(),
    });
    await this.#event(article, "publish_failed", "publishing", "failed_publish", message);
  }

  async #latestApprovedHash(articleId: string): Promise<string | undefined> {
    const events = await this.store.listEvents(articleId);
    for (const event of events.toReversed()) {
      if (stringCell(event.event_type) !== "approved") continue;
      try {
        const payload = JSON.parse(stringCell(event.payload_json)) as { hash?: unknown };
        if (typeof payload.hash === "string") return payload.hash;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async #markConflict(
    article: Article,
    currentHash: string,
    approvedHash: string | undefined,
  ): Promise<void> {
    await this.#setConflict(article, "changed_after_approval", "Article content changed after Telegram approval", {
      current_hash: currentHash,
      approved_hash: approvedHash ?? null,
    });
  }

  async #setConflict(
    article: Article,
    blocker: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    assertTransition(article.status, "conflict");
    const now = new Date().toISOString();
    await this.store.patchArticle(article.article_id, {
      status: "conflict",
      qa_blockers: blocker,
      manual_required: true,
      last_error: message,
      updated_at: now,
    });
    await this.#event(
      article,
      "publication_conflict",
      article.status,
      "conflict",
      message,
      payload,
    );
  }

  async #event(
    article: Article,
    eventType: string,
    fromStatus: string,
    toStatus: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendEvent({
      event_id: randomUUID(),
      article_id: article.article_id,
      event_type: eventType,
      from_status: fromStatus,
      to_status: toStatus,
      actor_type: "system",
      actor_id: "publisher",
      provider: "ghost",
      message,
      payload_json: payload ? JSON.stringify(payload) : "",
      created_at: new Date().toISOString(),
    });
  }
}

export function publicationIsEnabled(
  config: Pick<AppConfig, "dryRun" | "allowGhostPublish" | "targetEnvironment">,
  settings: Map<string, unknown>,
): boolean {
  const baseGate =
    !config.dryRun &&
    config.allowGhostPublish &&
    booleanCell(asCell(settings.get("publication_enabled")));
  if (!baseGate) return false;

  // Staging is the acceptance environment: publishing there is explicitly
  // enabled by the server and Sheet gates above. Production additionally
  // requires the security and technical SEO readiness attestations.
  if (config.targetEnvironment === "staging") return true;
  return (
    booleanCell(asCell(settings.get("security_ready"))) &&
    booleanCell(asCell(settings.get("technical_seo_ready")))
  );
}

function parseScheduledDate(article: Article, timeZone: string): Date | undefined {
  const raw = article.scheduled_publish_at;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const date = dateCell(raw, timeZone);
  if (!date) throw new Error(`Invalid scheduled_publish_at: ${stringCell(raw)}`);
  return date;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Ghost\s+[A-Za-z0-9._-]+/g, "Ghost [REDACTED]").slice(0, 500);
}

function asCell(value: unknown): string | number | boolean | null | undefined {
  return ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean)
    : value === null
      ? null
      : undefined;
}

async function verifyPublicPage(url: string): Promise<{ ok: boolean; status?: number; message: string }> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return { ok: false, status: response.status, message: `Public URL returned ${response.status}` };
    const html = await response.text();
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1];
    if (canonical && normalizeUrl(canonical) !== normalizeUrl(url)) {
      return { ok: false, status: response.status, message: `Canonical mismatch: ${canonical}` };
    }
    return { ok: true, status: response.status, message: "Public page verified" };
  } catch (error) {
    return { ok: false, message: `Public verification failed: ${sanitizeError(error)}` };
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, "");
}
