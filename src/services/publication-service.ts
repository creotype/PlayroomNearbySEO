import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { Article, CellValue } from "../domain/article.js";
import { articleContentHash, booleanCell, dateCell, stringCell } from "../domain/article.js";
import { assertTransition } from "../domain/transitions.js";
import type { GhostAdminClient, GhostPost } from "../ghost/client.js";
import { buildGhostPayload, ghostArticleSlug, publicArticleUrl } from "../ghost/payload.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import { nextPublicationAt, parseLocalClockTime } from "./editorial-clock.js";

const DEFAULT_PUBLICATION_GRACE_MINUTES = 15;

export class PublicationService {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly ghost: GhostAdminClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly mutex: KeyedMutex,
    private readonly clock: () => Date = () => new Date(),
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
    const currentHash = articleContentHash(article);
    const approvedHash = await this.#latestApprovedHash(article.article_id);
    if (!approvedHash || approvedHash !== currentHash || stringCell(article.content_hash) !== currentHash) {
      await this.#markConflict(article, currentHash, approvedHash);
      return;
    }

    const now = this.clock();
    if (article.status === "approved" && scheduledAt && scheduledAt.getTime() > now.getTime()) {
      assertTransition("approved", "scheduled");
      const now = new Date().toISOString();
      await this.store.patchArticle(article.article_id, { status: "scheduled", updated_at: now });
      await this.#event(article, "scheduled", "approved", "scheduled", "Scheduled for publication", {
        scheduled_at: scheduledAt.toISOString(),
      });
      return;
    }
    if (article.status === "scheduled" && scheduledAt && scheduledAt.getTime() > now.getTime()) return;
    if (
      scheduledAt &&
      now.getTime() - scheduledAt.getTime() > publicationGraceMs(await this.store.getSettings())
    ) {
      await this.#rescheduleMissedWindow(article, currentHash, scheduledAt, now, timeZone, "scheduled");
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
      await this.#failPublishing(article, message);
    }
  }

  async #rescheduleMissedWindow(
    article: Article,
    previousHash: string,
    previousSchedule: Date,
    now: Date,
    timeZone: string,
    targetStatus: "approved" | "scheduled",
  ): Promise<void> {
    if (article.status !== targetStatus) assertTransition(article.status, targetStatus);
    const settings = await this.store.getSettings();
    const publicationTime = parseLocalClockTime(
      settings.get("publication_time") as CellValue | undefined,
      this.config.publicationTime,
    );
    const nextSchedule = nextPublicationAt(now, timeZone, publicationTime);
    const nextScheduleIso = nextSchedule.toISOString();
    const candidate = {
      ...article,
      status: targetStatus,
      scheduled_publish_at: nextScheduleIso,
    } as Article;
    const nextHash = articleContentHash(candidate);
    const updatedAt = now.toISOString();
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        status: targetStatus,
        scheduled_publish_at: nextScheduleIso,
        content_hash: nextHash,
        updated_at: updatedAt,
      },
      {
        event_id: stableRescheduleEventId(
          article.article_id,
          article.status,
          targetStatus,
          previousSchedule,
          nextSchedule,
        ),
        article_id: article.article_id,
        event_type: "publication_rescheduled",
        from_status: article.status,
        to_status: targetStatus,
        actor_type: "system",
        actor_id: "publisher-rescheduler",
        provider: "system",
        provider_object_id: `missed-window:${previousSchedule.toISOString()}`,
        message: "Missed publication window rescheduled to the next configured local time",
        payload_json: JSON.stringify({
          hash: nextHash,
          previous_hash: previousHash,
          previous_scheduled_at: previousSchedule.toISOString(),
          scheduled_publish_at: nextScheduleIso,
          detected_at: updatedAt,
        }),
        created_at: updatedAt,
      },
    );
  }

  async #upsertAndPublish(article: Article, expectedHash: string): Promise<GhostPost> {
    assertHeroImageReady(article);
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
    const now = this.clock();
    const claimedAt = dateCell(article.updated_at, timeZone);
    const staleAfterMs = Math.max(this.config.pollIntervalMs * 4, 5 * 60_000);
    if (claimedAt && now.getTime() - claimedAt.getTime() < staleAfterMs) return;

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
    if (ghostPost.status === "published") {
      await this.#finalizePublished(article, ghostPost, currentHash);
      return;
    }
    const scheduledAt = parseScheduledDate(article, timeZone);
    if (
      ghostPost.status === "draft" &&
      scheduledAt &&
      now.getTime() - scheduledAt.getTime() > publicationGraceMs(await this.store.getSettings())
    ) {
      await this.#rescheduleMissedWindow(
        article,
        currentHash,
        scheduledAt,
        now,
        timeZone,
        "approved",
      );
      return;
    }
    try {
      const published = await this.#upsertAndPublish(article, currentHash);
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
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        status: "published",
        ghost_post_id: published.id,
        ghost_updated_at: published.updated_at,
        ghost_draft_url: published.url,
        public_url: publicUrl,
        published_at: published.published_at ?? now,
        last_error: verification.ok ? "" : verification.message,
        updated_at: now,
      },
      {
        event_id: randomUUID(),
        article_id: article.article_id,
        event_type: "published",
        from_status: "publishing",
        to_status: "published",
        actor_type: "system",
        actor_id: "publisher",
        provider: "ghost",
        message: "Published to Ghost",
        payload_json: JSON.stringify({
          hash: currentHash,
          ghost_post_id: published.id,
          public_url: publicUrl,
          verification,
        }),
        created_at: now,
      },
    );
  }

  async #failPublishing(article: Article, message: string): Promise<void> {
    const current = await this.store.findArticle(article.article_id);
    if (!current || current.status !== "publishing") return;
    assertTransition("publishing", "failed_publish");
    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      current.article_id,
      {
        status: "failed_publish",
        last_error: message,
        updated_at: now,
      },
      {
        event_id: randomUUID(),
        article_id: current.article_id,
        event_type: "publish_failed",
        from_status: "publishing",
        to_status: "failed_publish",
        actor_type: "system",
        actor_id: "publisher",
        provider: "ghost",
        message,
        payload_json: "",
        created_at: now,
      },
    );
  }

  async #latestApprovedHash(articleId: string): Promise<string | undefined> {
    const events = await this.store.listEvents(articleId);
    for (const event of events.toReversed()) {
      const eventType = stringCell(event.event_type);
      if (eventType !== "approved" && eventType !== "publication_rescheduled") continue;
      if (
        eventType === "publication_rescheduled" &&
        !(
          stringCell(event.actor_id) === "publisher-rescheduler" &&
          stringCell(event.provider) === "system"
        )
      ) {
        continue;
      }
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
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        status: "conflict",
        qa_blockers: blocker,
        manual_required: true,
        last_error: message,
        updated_at: now,
      },
      {
        event_id: randomUUID(),
        article_id: article.article_id,
        event_type: "publication_conflict",
        from_status: article.status,
        to_status: "conflict",
        actor_type: "system",
        actor_id: "publisher",
        provider: "ghost",
        message,
        payload_json: payload ? JSON.stringify(payload) : "",
        created_at: now,
      },
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

function assertHeroImageReady(article: Article): void {
  const imageUrl = stringCell(article.feature_image_url);
  if (!imageUrl) {
    throw new Error("Hero image is missing; publication is blocked until generation/upload succeeds");
  }
  const alt = stringCell(article.feature_image_alt);
  if (!alt) {
    throw new Error("Hero image alt text is missing; publication is blocked until it is added");
  }
  try {
    const parsed = new URL(imageUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error("Hero image URL is invalid; publication is blocked until it is fixed");
  }
}

function asCell(value: unknown): string | number | boolean | null | undefined {
  return ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean)
    : value === null
      ? null
      : undefined;
}

function publicationGraceMs(settings: Map<string, CellValue>): number {
  const configured = Number(settings.get("publication_grace_minutes"));
  const minutes = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 60)
    : DEFAULT_PUBLICATION_GRACE_MINUTES;
  return minutes * 60_000;
}

function stableRescheduleEventId(
  articleId: string,
  fromStatus: string,
  toStatus: string,
  from: Date,
  to: Date,
): string {
  const source = `${articleId}:${fromStatus}:${toStatus}:${from.toISOString()}:${to.toISOString()}`;
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `evt-publication-rescheduled-${hash}`;
}

export type PublicPageVerification = { ok: boolean; status?: number; message: string };

export async function verifyPublicPage(url: string): Promise<PublicPageVerification> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, status: response.status, message: `Public URL returned ${response.status}` };
    if (response.url && normalizeUrl(response.url) !== normalizeUrl(url)) {
      return {
        ok: false,
        status: response.status,
        message: `Public URL redirected to ${response.url}`,
      };
    }
    const html = await response.text();
    const canonical = canonicalUrl(html, response.url || url);
    if (!canonical.url) {
      return { ok: false, status: response.status, message: canonical.error };
    }
    if (normalizeUrl(canonical.url) !== normalizeUrl(url)) {
      return { ok: false, status: response.status, message: `Canonical mismatch: ${canonical.url}` };
    }
    return { ok: true, status: response.status, message: "Public page verified" };
  } catch (error) {
    return { ok: false, message: `Public verification failed: ${sanitizeError(error)}` };
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function canonicalUrl(
  html: string,
  baseUrl: string,
): { url?: string; error: string } {
  const canonicalTags: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel");
    if (!rel?.split(/\s+/u).some((token) => token.toLowerCase() === "canonical")) continue;
    canonicalTags.push(tag);
  }
  if (canonicalTags.length === 0) return { error: "Canonical link missing" };
  if (canonicalTags.length > 1) return { error: "Multiple canonical links" };
  const href = htmlAttribute(canonicalTags[0]!, "href");
  if (!href) return { error: "Invalid canonical URL" };
  try {
    return { url: new URL(href, baseUrl).toString(), error: "" };
  } catch {
    return { error: "Invalid canonical URL" };
  }
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
