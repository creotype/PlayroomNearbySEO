import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Article, SheetRecord } from "../src/domain/article.js";
import { articleContentHash } from "../src/domain/article.js";
import type { GhostAdminClient } from "../src/ghost/client.js";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { ApprovalService, type TelegramActor } from "../src/services/approval-service.js";
import {
  PublicationService,
  publicationIsEnabled,
  verifyPublicPage,
} from "../src/services/publication-service.js";
import type { QualityGate } from "../src/services/quality-gate.js";

const actor: TelegramActor = {
  id: 42,
  displayName: "Owner",
  providerObjectId: "message:-100:10",
};

const config: AppConfig = {
  nodeEnv: "test",
  spreadsheetId: "sheet",
  telegramBotToken: "123456789:abcdefghijklmnopqrstuvwxyz",
  ghostAdminUrl: "https://example.com/internal",
  ghostAdminApiKey: "abcdef:0123456789abcdef",
  ghostApiVersion: "v5.0",
  openAiModel: "gpt-5-mini",
  openAiImageModel: "gpt-image-2",
  openAiImageSize: "1536x1024",
  openAiImageQuality: "high",
  heroImageCacheDir: "data/hero-images",
  editorialAutomationEnabled: false,
  editorialTimeZone: "Europe/Belgrade",
  editorialRunDays: [1, 5],
  editorialRunTime: "10:00",
  autoPublishAfterReview: true,
  reviewDeadlineHours: 48,
  publicationTime: "10:00",
  targetEnvironment: "staging",
  port: 8080,
  logLevel: "silent",
  pollIntervalMs: 15_000,
  dryRun: false,
  allowGhostPublish: true,
  allowTelegramGeneration: false,
};

const logger = { error: vi.fn() } as unknown as Logger;

function approvedArticle(): Article {
  const article = {
    __rowNumber: 2,
    article_id: "SEO-1",
    locale: "sr",
    status: "approved",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "## Vodič\n\nDovoljno dugačak tekst.",
    excerpt: "Praktičan vodič",
    seo_title: "Kako izabrati igraonicu",
    meta_description: "Praktičan vodič za roditelje koji biraju igraonicu u Beogradu.",
    tags: "rs",
    source_urls: "https://example.com/source",
    internal_links: "https://example.com/rs/blog",
    feature_image_url: "https://example.com/content/images/playroom-hero.webp",
    feature_image_alt: "Tematska ilustracija: izbor igraonice",
    qa_status: "pass",
    qa_blockers: "",
    manual_required: false,
    scheduled_publish_at: "",
    ghost_post_id: "",
    updated_at: "2026-08-19T11:04:00.000Z",
  } as Article;
  article.content_hash = articleContentHash(article);
  return article;
}

function enabledSettings(): Map<string, string | boolean> {
  return new Map<string, string | boolean>([
    ["publication_enabled", true],
    ["security_ready", true],
    ["technical_seo_ready", true],
    ["timezone", "Europe/Belgrade"],
    ["staging_frontend_base_url", "https://example.com"],
  ]);
}

function approvalEvent(article: Article): SheetRecord {
  return {
    __rowNumber: 2,
    event_id: "event-1",
    article_id: article.article_id,
    event_type: "approved",
    actor_type: "telegram_user",
    actor_id: "42",
    provider: "telegram",
    provider_object_id: "telegram:message:-100:10",
    payload_json: JSON.stringify({ hash: articleContentHash(article) }),
  };
}

function ghostSpy(): { client: GhostAdminClient; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn();
  const client = {
    findPostBySlug: async () => {
      calls("findPostBySlug");
      return undefined;
    },
    createPost: async () => {
      calls("createPost");
      throw new Error("Ghost must not be called in this test");
    },
    readPost: async () => {
      calls("readPost");
      return undefined;
    },
    updatePost: async () => {
      calls("updatePost");
      throw new Error("Ghost must not be called in this test");
    },
  } as unknown as GhostAdminClient;
  return { client, calls };
}

describe("PublicationService concurrency hardening", () => {
  it.each([
    {
      name: "staging acceptance",
      targetEnvironment: "staging" as const,
      dryRun: false,
      allowGhostPublish: true,
      publicationEnabled: true,
      securityReady: false,
      technicalSeoReady: false,
      expected: true,
    },
    {
      name: "production ready",
      targetEnvironment: "production" as const,
      dryRun: false,
      allowGhostPublish: true,
      publicationEnabled: true,
      securityReady: true,
      technicalSeoReady: true,
      expected: true,
    },
    {
      name: "production security blocked",
      targetEnvironment: "production" as const,
      dryRun: false,
      allowGhostPublish: true,
      publicationEnabled: true,
      securityReady: false,
      technicalSeoReady: true,
      expected: false,
    },
    {
      name: "production SEO blocked",
      targetEnvironment: "production" as const,
      dryRun: false,
      allowGhostPublish: true,
      publicationEnabled: true,
      securityReady: true,
      technicalSeoReady: false,
      expected: false,
    },
    {
      name: "dry run kill switch",
      targetEnvironment: "staging" as const,
      dryRun: true,
      allowGhostPublish: true,
      publicationEnabled: true,
      securityReady: true,
      technicalSeoReady: true,
      expected: false,
    },
    {
      name: "server permission kill switch",
      targetEnvironment: "staging" as const,
      dryRun: false,
      allowGhostPublish: false,
      publicationEnabled: true,
      securityReady: true,
      technicalSeoReady: true,
      expected: false,
    },
    {
      name: "Sheet kill switch",
      targetEnvironment: "staging" as const,
      dryRun: false,
      allowGhostPublish: true,
      publicationEnabled: false,
      securityReady: true,
      technicalSeoReady: true,
      expected: false,
    },
  ])("evaluates the $name publication gate", (testCase) => {
    const settings = new Map<string, unknown>([
      ["publication_enabled", testCase.publicationEnabled],
      ["security_ready", testCase.securityReady],
      ["technical_seo_ready", testCase.technicalSeoReady],
    ]);
    expect(
      publicationIsEnabled(
        {
          targetEnvironment: testCase.targetEnvironment,
          dryRun: testCase.dryRun,
          allowGhostPublish: testCase.allowGhostPublish,
        },
        settings,
      ),
    ).toBe(testCase.expected);
  });

  it("allows explicitly enabled staging publication without production readiness attestations", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    const calls = vi.fn();
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ["publication_enabled", true],
        ["security_ready", false],
        ["technical_seo_ready", false],
        ["timezone", "Europe/Belgrade"],
        ["staging_frontend_base_url", "https://example.com"],
      ]),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = {
      findPostBySlug: async () => {
        calls("findPostBySlug");
        throw new Error("stop after gate verification");
      },
    } as unknown as GhostAdminClient;

    await new PublicationService(store, ghost, config, logger, new KeyedMutex()).runOnce();

    expect(calls).toHaveBeenCalledWith("findPostBySlug");
  });

  it("assigns a staff-token post to the authenticated Ghost user", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    const createPost = vi.fn(async (_input: unknown) => {
      throw new Error("stop after create payload verification");
    });
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = {
      findPostBySlug: async () => undefined,
      readCurrentUser: async () => ({ id: "ghost-author-1", name: "Owner", status: "active" }),
      createPost,
    } as unknown as GhostAdminClient;

    await new PublicationService(store, ghost, config, logger, new KeyedMutex()).runOnce();

    expect(createPost).toHaveBeenCalledOnce();
    expect(createPost.mock.calls[0]?.[0]).toMatchObject({
      status: "draft",
      authors: [{ id: "ghost-author-1" }],
    });
  });

  it("fails closed before Ghost when the approved article has no hero image", async () => {
    let current = {
      ...approvedArticle(),
      feature_image_url: "",
      feature_image_alt: "",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const ghostCalls = vi.fn();
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = {
      findPostBySlug: async () => ghostCalls("findPostBySlug"),
      createPost: async () => ghostCalls("createPost"),
      readPost: async () => ghostCalls("readPost"),
      updatePost: async () => ghostCalls("updatePost"),
    } as unknown as GhostAdminClient;

    await new PublicationService(store, ghost, config, logger, new KeyedMutex()).runOnce();

    expect(current.status).toBe("failed_publish");
    expect(current.last_error).toContain("Hero image is missing");
    expect(ghostCalls).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ event_type: "publish_failed" });
  });

  it("keeps production blocked until security and technical SEO are ready", async () => {
    const current = approvedArticle();
    const calls = vi.fn();
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ["publication_enabled", true],
        ["security_ready", false],
        ["technical_seo_ready", false],
      ]),
      listArticles: async () => {
        calls("listArticles");
        return [{ ...current }];
      },
    } as unknown as GoogleSheetsStore;
    const productionConfig: AppConfig = { ...config, targetEnvironment: "production" };

    await new PublicationService(
      store,
      ghostSpy().client,
      productionConfig,
      logger,
      new KeyedMutex(),
    ).runOnce();

    expect(calls).not.toHaveBeenCalled();
  });

  it("serializes cancellation and publication with the shared article mutex", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationEntered!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      cancellationEntered = resolve;
    });
    let candidateListed!: () => void;
    const candidateWasListed = new Promise<void>((resolve) => {
      candidateListed = resolve;
    });

    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => {
        candidateListed();
        return [{ ...current }];
      },
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        cancellationEntered();
        await cancellationGate;
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      },
    } as unknown as GoogleSheetsStore;
    const mutex = new KeyedMutex();
    const approvals = new ApprovalService(
      store,
      { evaluate: async () => ({ passed: true, blockers: [], score: 10 }) } as unknown as QualityGate,
      mutex,
    );
    const ghost = ghostSpy();
    const publisher = new PublicationService(store, ghost.client, config, logger, mutex);

    const cancellation = approvals.cancel(current.article_id, "Do not publish", actor);
    await cancellationStarted;
    const publication = publisher.runOnce();
    await candidateWasListed;
    expect(ghost.calls).not.toHaveBeenCalled();

    releaseCancellation();
    await Promise.all([cancellation, publication]);
    expect(current.status).toBe("cancelled");
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("rechecks a claimed row and stops before Ghost when Sheet status changes", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    const ghost = ghostSpy();
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        if (event.event_type === "publishing_started") {
          current = { ...current, status: "cancelled" } as Article;
        }
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        if (event.event_type === "publishing_started") {
          current = { ...current, status: "cancelled" } as Article;
        }
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const publisher = new PublicationService(store, ghost.client, config, logger, new KeyedMutex());

    await publisher.runOnce();

    expect(current.status).toBe("cancelled");
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("atomically records the published article state and its audit event", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    const atomicWrites: Array<{
      patch: Record<string, unknown>;
      event: Record<string, unknown>;
    }> = [];
    const patchArticle = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      current = { ...current, ...patch } as Article;
      return current;
    });
    const appendEvent = vi.fn(async (event: Record<string, unknown>) => {
      events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
    });
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        atomicWrites.push({ patch, event });
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
      appendEvent,
    } as unknown as GoogleSheetsStore;
    const draft = {
      id: "ghost-post-1",
      title: current.title,
      slug: "kako-izabrati-igraonicu-rs",
      status: "draft" as const,
      url: "https://example.com/internal/ghost-post-1/",
      updated_at: "2026-08-19T12:00:00.000Z",
      published_at: null,
    };
    const published = {
      ...draft,
      status: "published" as const,
      updated_at: "2026-08-19T12:01:00.000Z",
      published_at: "2026-08-19T12:01:00.000Z",
    };
    const ghost = {
      findPostBySlug: async () => undefined,
      readCurrentUser: async () => undefined,
      createPost: async () => draft,
      readPost: async () => draft,
      updatePost: async () => published,
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<html><head><link rel="canonical" href="${publicUrl}"></head></html>`, {
          status: 200,
        }),
      ),
    );

    try {
      await new PublicationService(store, ghost, config, logger, new KeyedMutex()).runOnce();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(atomicWrites).toHaveLength(2);
    expect(atomicWrites[0]?.event).toMatchObject({
      event_type: "publishing_started",
      from_status: "approved",
      to_status: "publishing",
    });
    const atomicWrite = atomicWrites.find(({ event }) => event.event_type === "published")!;
    expect(atomicWrite.patch).toMatchObject({
      status: "published",
      ghost_post_id: published.id,
      public_url: publicUrl,
    });
    expect(atomicWrite.event).toMatchObject({
      article_id: current.article_id,
      event_type: "published",
      from_status: "publishing",
      to_status: "published",
      provider: "ghost",
    });
    expect(JSON.parse(String(atomicWrite.event.payload_json))).toMatchObject({
      ghost_post_id: published.id,
      public_url: publicUrl,
      verification: {
        ok: true,
        status: 200,
        message: "Public page verified",
      },
    });
    expect(
      patchArticle.mock.calls.some(([, patch]) => patch.status === "published"),
    ).toBe(false);
    expect(
      appendEvent.mock.calls.some(([event]) => event.event_type === "published"),
    ).toBe(false);
    expect(current.status).toBe("published");
  });

  it("atomically records a failed publication and its audit event", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [approvalEvent(current)];
    const atomicWrites: Array<{
      patch: Record<string, unknown>;
      event: Record<string, unknown>;
    }> = [];
    const patchArticle = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      current = { ...current, ...patch } as Article;
      return current;
    });
    const appendEvent = vi.fn(async (event: Record<string, unknown>) => {
      events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
    });
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        atomicWrites.push({ patch, event });
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
      appendEvent,
    } as unknown as GoogleSheetsStore;
    const ghost = {
      findPostBySlug: async () => {
        throw new Error("Ghost API unavailable");
      },
    } as unknown as GhostAdminClient;

    await new PublicationService(store, ghost, config, logger, new KeyedMutex()).runOnce();

    expect(atomicWrites).toHaveLength(2);
    expect(atomicWrites[0]?.event).toMatchObject({
      event_type: "publishing_started",
      from_status: "approved",
      to_status: "publishing",
    });
    const failedWrite = atomicWrites.find(({ event }) => event.event_type === "publish_failed")!;
    expect(failedWrite.patch).toMatchObject({
      status: "failed_publish",
    });
    expect(failedWrite.event).toMatchObject({
      article_id: current.article_id,
      event_type: "publish_failed",
      from_status: "publishing",
      to_status: "failed_publish",
      provider: "ghost",
    });
    expect(
      patchArticle.mock.calls.some(([, patch]) => patch.status === "failed_publish"),
    ).toBe(false);
    expect(
      appendEvent.mock.calls.some(([event]) => event.event_type === "publish_failed"),
    ).toBe(false);
    expect(current.status).toBe("failed_publish");
  });

  it.each(["approved", "scheduled"] as const)(
    "atomically returns manually edited %s content to a fresh review window",
    async (status) => {
      let current = {
        ...approvedArticle(),
        status,
        ...(status === "scheduled"
          ? { scheduled_publish_at: "2026-09-18T08:00:00.000Z" }
          : {}),
      } as Article;
      current.content_hash = articleContentHash(current);
      const events: SheetRecord[] = [approvalEvent(current)];
      current = {
        ...current,
        body_markdown: `${current.body_markdown}\n\nRučno ispravljen tekst.`,
      } as Article;
      const atomicWrites: Array<{
        patch: Record<string, unknown>;
        event: Record<string, unknown>;
      }> = [];
      const patchArticle = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      });
      const appendEvent = vi.fn(async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      });
      const store = {
        getSettings: async () => enabledSettings(),
        listArticles: async () => [{ ...current }],
        findArticle: async () => current,
        listEvents: async () => events,
        patchArticle,
        patchArticleAndAppendEvent: async (
          _id: string,
          patch: Record<string, unknown>,
          event: Record<string, unknown>,
        ) => {
          atomicWrites.push({ patch, event });
          current = { ...current, ...patch } as Article;
          events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
          return current;
        },
        appendEvent,
      } as unknown as GoogleSheetsStore;
      const ghost = ghostSpy();

      await new PublicationService(store, ghost.client, config, logger, new KeyedMutex()).runOnce();

      expect(atomicWrites).toHaveLength(1);
      expect(atomicWrites[0]?.patch).toMatchObject({
        status: "needs_review",
        qa_status: "pending",
        qa_blockers: "",
        quality_score: "",
        manual_required: false,
        content_hash: "",
        approved_by: "",
        approved_at: "",
        scheduled_publish_at: "",
      });
      expect(atomicWrites[0]?.event).toMatchObject({
        article_id: current.article_id,
        event_type: "publication_reopened",
        from_status: status,
        to_status: "needs_review",
        provider: "system",
      });
      expect(
        patchArticle.mock.calls.some(([, patch]) => patch.status === "conflict"),
      ).toBe(false);
      expect(
        appendEvent.mock.calls.some(([event]) => event.event_type === "publication_reopened"),
      ).toBe(false);
      expect(current.status).toBe("needs_review");
      expect(ghost.calls).not.toHaveBeenCalled();
    },
  );

  it("keeps an approval-state mismatch as a conflict instead of treating it as a text edit", async () => {
    let current = approvedArticle();
    current.content_hash = "tampered-system-hash";
    const events: SheetRecord[] = [approvalEvent(current)];
    events[0]!.payload_json = JSON.stringify({ hash: articleContentHash(current) });
    const atomicWrites: Array<{ patch: Record<string, unknown>; event: Record<string, unknown> }> = [];
    const store = {
      getSettings: async () => enabledSettings(),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        atomicWrites.push({ patch, event });
        current = { ...current, ...patch } as Article;
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = ghostSpy();

    await new PublicationService(store, ghost.client, config, logger, new KeyedMutex()).runOnce();

    expect(atomicWrites[0]?.patch).toMatchObject({
      status: "conflict",
      qa_blockers: "approval_state_mismatch",
      manual_required: true,
    });
    expect(atomicWrites[0]?.event).toMatchObject({
      event_type: "publication_conflict",
      from_status: "approved",
      to_status: "conflict",
    });
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("reschedules a materially missed 10:00 window after restart and preserves hash authorization", async () => {
    let current = {
      ...approvedArticle(),
      status: "scheduled",
      scheduled_publish_at: "2026-09-07T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const atomicWrites: Array<{ patch: Record<string, unknown>; event: Record<string, unknown> }> = [];
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ...enabledSettings(),
        ["publication_time", "10:00"],
      ]),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        atomicWrites.push({ patch, event });
        current = { ...current, ...patch } as Article;
        if (!events.some((existing) => existing.event_id === event.event_id)) {
          events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        }
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = ghostSpy();
    const restartedAt = new Date("2026-09-07T13:00:00.000Z"); // 15:00 Belgrade
    const publisher = new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
      () => restartedAt,
    );

    await publisher.runOnce();
    await publisher.runOnce();

    expect(ghost.calls).not.toHaveBeenCalled();
    expect(current.status).toBe("scheduled");
    expect(current.scheduled_publish_at).toBe("2026-09-08T08:00:00.000Z");
    expect(current.content_hash).toBe(articleContentHash(current));
    expect(atomicWrites).toHaveLength(1);
    expect(atomicWrites[0]?.event).toMatchObject({
      event_type: "publication_rescheduled",
      actor_id: "publisher-rescheduler",
      provider: "system",
    });
    expect(JSON.parse(String(atomicWrites[0]?.event.payload_json))).toMatchObject({
      hash: current.content_hash,
      previous_scheduled_at: "2026-09-07T08:00:00.000Z",
      scheduled_publish_at: "2026-09-08T08:00:00.000Z",
    });
    expect(events.filter((event) => event.event_type === "publication_rescheduled")).toHaveLength(1);
  });

  it("also reschedules an approved row whose first scheduling tick was missed", async () => {
    let current = {
      ...approvedArticle(),
      status: "approved",
      scheduled_publish_at: "2026-09-07T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const writes: Array<{ patch: Record<string, unknown>; event: Record<string, unknown> }> = [];
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ...enabledSettings(),
        ["publication_time", "10:00"],
      ]),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        writes.push({ patch, event });
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = ghostSpy();
    const publisher = new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
      () => new Date("2026-09-07T13:00:00.000Z"),
    );

    await publisher.runOnce();

    expect(ghost.calls).not.toHaveBeenCalled();
    expect(current.status).toBe("scheduled");
    expect(current.scheduled_publish_at).toBe("2026-09-08T08:00:00.000Z");
    expect(current.content_hash).toBe(articleContentHash(current));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.event).toMatchObject({
      event_type: "publication_rescheduled",
      from_status: "approved",
      to_status: "scheduled",
    });
  });

  it("reschedules a stale scheduled claim even when an older manual request has the same hash", async () => {
    let current = {
      ...approvedArticle(),
      status: "publishing",
      scheduled_publish_at: "2026-09-07T08:00:00.000Z",
      ghost_post_id: "ghost-draft-1",
      ghost_updated_at: "2026-09-07T08:00:10.000Z",
      updated_at: "2026-09-07T08:00:20.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [
      approvalEvent(current),
      {
        __rowNumber: 3,
        event_id: "historical-manual-request",
        article_id: current.article_id,
        event_type: "manual_publish_requested",
        from_status: "scheduled",
        to_status: "publishing",
        actor_type: "telegram_user",
        actor_id: "42",
        provider: "telegram",
        provider_object_id: "telegram:message:-100:old",
        payload_json: JSON.stringify({ hash: articleContentHash(current) }),
      },
      {
        __rowNumber: 4,
        event_id: "newer-scheduled-claim",
        article_id: current.article_id,
        event_type: "publishing_started",
        from_status: "scheduled",
        to_status: "publishing",
        actor_type: "system",
        actor_id: "publisher",
        provider: "ghost",
        payload_json: JSON.stringify({ hash: articleContentHash(current) }),
      },
    ];
    const writes: Array<{ patch: Record<string, unknown>; event: Record<string, unknown> }> = [];
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ...enabledSettings(),
        ["publication_time", "10:00"],
      ]),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        writes.push({ patch, event });
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const updatePost = vi.fn();
    const ghost = {
      readPost: vi.fn(async () => ({
        id: "ghost-draft-1",
        title: current.title,
        slug: "kako-izabrati-igraonicu-rs",
        status: "draft" as const,
        url: "https://example.com/internal/ghost-draft-1/",
        updated_at: "2026-09-07T08:00:10.000Z",
        published_at: null,
      })),
      updatePost,
    } as unknown as GhostAdminClient;
    const publisher = new PublicationService(
      store,
      ghost,
      config,
      logger,
      new KeyedMutex(),
      () => new Date("2026-09-07T13:00:00.000Z"),
    );

    await publisher.runOnce();

    expect(updatePost).not.toHaveBeenCalled();
    expect(current.status).toBe("approved");
    expect(current.scheduled_publish_at).toBe("2026-09-08T08:00:00.000Z");
    expect(current.content_hash).toBe(articleContentHash(current));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.event).toMatchObject({
      event_type: "publication_rescheduled",
      from_status: "publishing",
      to_status: "approved",
      actor_id: "publisher-rescheduler",
    });
  });

  it("allows normal polling within the bounded grace after 10:00", async () => {
    let current = {
      ...approvedArticle(),
      status: "scheduled",
      scheduled_publish_at: "2026-09-07T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const calls = vi.fn();
    const store = {
      getSettings: async () => new Map<string, string | boolean>([
        ...enabledSettings(),
        ["publication_time", "10:00"],
      ]),
      listArticles: async () => [{ ...current }],
      findArticle: async () => current,
      listEvents: async () => events,
      patchArticle: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as Article;
        return current;
      },
      appendEvent: async (event: Record<string, unknown>) => {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      },
      patchArticleAndAppendEvent: async (
        _id: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch } as Article;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        return current;
      },
    } as unknown as GoogleSheetsStore;
    const ghost = {
      findPostBySlug: async () => {
        calls("findPostBySlug");
        return undefined;
      },
      readCurrentUser: async () => undefined,
      createPost: async () => {
        calls("createPost");
        throw new Error("stop after grace verification");
      },
    } as unknown as GhostAdminClient;
    const publisher = new PublicationService(
      store,
      ghost,
      config,
      logger,
      new KeyedMutex(),
      () => new Date("2026-09-07T08:05:00.000Z"),
    );

    await publisher.runOnce();

    expect(calls).toHaveBeenCalledWith("findPostBySlug");
    expect(events.some((event) => event.event_type === "publication_rescheduled")).toBe(false);
  });
});

describe("PublicationService.publishNow", () => {
  it("publishes a future-scheduled approved version immediately and deduplicates the command", async () => {
    let current = {
      ...approvedArticle(),
      status: "scheduled",
      scheduled_publish_at: "2026-09-17T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const originalSchedule = current.scheduled_publish_at;
    const events: SheetRecord[] = [approvalEvent(current)];
    const createPost = vi.fn(async () => draftPost(current));
    const updatePost = vi.fn(async (_id: string, _input: Record<string, unknown>) =>
      publishedPost(current));
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const ghost = {
      findPostBySlug: vi.fn(async () => undefined),
      readCurrentUser: vi.fn(async () => undefined),
      createPost,
      readPost: vi.fn(async () => draftPost(current)),
      updatePost,
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<link rel="canonical" href="${publicUrl}">`, { status: 200 }),
      ),
    );

    try {
      const publisher = new PublicationService(store, ghost, config, logger, new KeyedMutex());
      const first = await publisher.publishNow(current.article_id, actor);
      const duplicate = await publisher.publishNow(current.article_id, actor);

      expect(first).toMatchObject({ outcome: "published", article: { status: "published" } });
      expect(duplicate).toMatchObject({ outcome: "already_published" });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createPost).toHaveBeenCalledOnce();
    expect(updatePost).toHaveBeenCalledOnce();
    expect(current.scheduled_publish_at).toBe(originalSchedule);
    const requests = events.filter((event) => event.event_type === "manual_publish_requested");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      from_status: "scheduled",
      to_status: "publishing",
      actor_type: "telegram_user",
      actor_id: "42",
      provider: "telegram",
      provider_object_id: "telegram:message:-100:10",
    });
    expect(JSON.parse(String(requests[0]?.payload_json))).toMatchObject({
      hash: articleContentHash({ ...current, status: "scheduled" } as Article),
      display_name: "Owner",
      scheduled_publish_at: originalSchedule,
    });
  });

  it("retries a failed publication with its bound Ghost draft after all gates pass", async () => {
    let current = {
      ...approvedArticle(),
      status: "failed_publish",
      ghost_post_id: "ghost-post-manual",
      scheduled_publish_at: "2026-09-17T08:00:00.000Z",
      last_error: "Temporary Ghost 503",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const updatePost = vi.fn(async (_id: string, _input: Record<string, unknown>) =>
      publishedPost(current));
    const ghost = {
      readPost: vi.fn(async () => draftPost(current)),
      updatePost,
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<link rel="canonical" href="${publicUrl}">`, { status: 200 }),
      ),
    );

    try {
      const result = await new PublicationService(
        store,
        ghost,
        config,
        logger,
        new KeyedMutex(),
      ).publishNow(current.article_id, { ...actor, providerObjectId: "message:-100:11" });
      expect(result).toMatchObject({ outcome: "published", article: { status: "published" } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(updatePost).toHaveBeenCalledOnce();
    expect(events.find((event) => event.event_type === "manual_publish_requested")).toMatchObject({
      from_status: "failed_publish",
      to_status: "publishing",
      provider_object_id: "telegram:message:-100:11",
    });
  });

  it("idempotently updates the bound post after a lost successful response", async () => {
    let current = {
      ...approvedArticle(),
      status: "failed_publish",
      ghost_post_id: "ghost-post-manual",
      last_error: "Ghost response was lost",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const updatePost = vi.fn(async (_id: string, _input: Record<string, unknown>) =>
      publishedPost(current));
    const ghost = {
      readPost: vi.fn(async () => publishedPost(current)),
      updatePost,
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<link rel="canonical" href="${publicUrl}">`, { status: 200 }),
      ),
    );

    try {
      const result = await new PublicationService(
        store,
        ghost,
        config,
        logger,
        new KeyedMutex(),
      ).publishNow(current.article_id, { ...actor, providerObjectId: "message:-100:12" });
      expect(result).toMatchObject({ outcome: "published", article: { status: "published" } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(ghost.readPost).toHaveBeenCalledTimes(2);
    expect(updatePost).toHaveBeenCalledOnce();
    expect(updatePost.mock.calls[0]?.[0]).toBe("ghost-post-manual");
    expect(updatePost.mock.calls[0]?.[1]).toMatchObject({ status: "published" });
  });

  it("updates a bound published post with the current reapproved Sheet content", async () => {
    let current = {
      ...approvedArticle(),
      status: "failed_publish",
      ghost_post_id: "ghost-post-manual",
      body_markdown: "## Ispravljena verzija\n\nFreshly reapproved body from Google Sheets.",
      last_error: "Previous publication response was lost",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const updatePost = vi.fn(async (_id: string, _input: Record<string, unknown>) =>
      publishedPost(current));
    const ghost = {
      readPost: vi.fn(async () => publishedPost(current)),
      updatePost,
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<link rel="canonical" href="${publicUrl}">`, { status: 200 }),
      ),
    );

    try {
      const result = await new PublicationService(
        store,
        ghost,
        config,
        logger,
        new KeyedMutex(),
      ).publishNow(current.article_id, { ...actor, providerObjectId: "message:-100:reapproved" });
      expect(result).toMatchObject({ outcome: "published", article: { status: "published" } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(updatePost).toHaveBeenCalledOnce();
    expect(updatePost.mock.calls[0]?.[0]).toBe("ghost-post-manual");
    expect(updatePost.mock.calls[0]?.[1]).toMatchObject({
      status: "published",
      html: expect.stringContaining("Freshly reapproved body from Google Sheets."),
    });
  });

  it("fails closed when a failed unbound row collides with an existing Ghost slug", async () => {
    let current = {
      ...approvedArticle(),
      status: "failed_publish",
      ghost_post_id: "",
      last_error: "Temporary Ghost error",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const createPost = vi.fn();
    const updatePost = vi.fn();
    const ghost = {
      findPostBySlug: vi.fn(async () => draftPost(current)),
      createPost,
      updatePost,
    } as unknown as GhostAdminClient;

    const result = await new PublicationService(
      store,
      ghost,
      config,
      logger,
      new KeyedMutex(),
    ).publishNow(current.article_id, { ...actor, providerObjectId: "message:-100:13" });

    expect(result).toMatchObject({
      outcome: "failed",
      article: { status: "failed_publish" },
    });
    expect(result.outcome === "failed" ? result.message : "").toContain(
      "already exists without matching ghost_post_id",
    );
    expect(createPost).not.toHaveBeenCalled();
    expect(updatePost).not.toHaveBeenCalled();
  });

  it("does not retry failed Ghost work for an exact duplicate Telegram command", async () => {
    let current = {
      ...approvedArticle(),
      status: "failed_publish",
      last_error: "Temporary Ghost 503",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [
      approvalEvent(current),
      {
        __rowNumber: 3,
        event_id: "manual-failed-command",
        article_id: current.article_id,
        event_type: "manual_publish_requested",
        from_status: "scheduled",
        to_status: "publishing",
        actor_type: "telegram_user",
        actor_id: "42",
        provider: "telegram",
        provider_object_id: "telegram:message:-100:10",
        payload_json: JSON.stringify({ hash: articleContentHash(current) }),
      },
    ];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const ghost = ghostSpy();

    const result = await new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
    ).publishNow(current.article_id, actor);

    expect(result).toMatchObject({ outcome: "failed", message: "Temporary Ghost 503" });
    expect(events.filter((event) => event.event_type === "manual_publish_requested")).toHaveLength(1);
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("surfaces missing trusted approval before a dirty QA state and never calls Ghost", async () => {
    let current = {
      ...approvedArticle(),
      status: "scheduled",
      scheduled_publish_at: "2026-09-17T08:00:00.000Z",
      qa_status: "fail",
      qa_blockers: "quality_score_below_threshold",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const ghost = ghostSpy();

    const result = await new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
    ).publishNow(current.article_id, actor);

    expect(result).toMatchObject({
      outcome: "blocked",
      reason: "missing_trusted_approval",
      article: { status: "conflict" },
    });
    expect(events.some((event) => event.event_type === "manual_publish_requested")).toBe(false);
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("blocks a dirty QA state before recording a request or touching Ghost", async () => {
    let current = {
      ...approvedArticle(),
      qa_status: "fail",
      qa_blockers: "quality_score_below_threshold",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const ghost = ghostSpy();

    const result = await new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
    ).publishNow(current.article_id, actor);

    expect(result).toMatchObject({
      outcome: "blocked",
      reason: "qa_not_passed",
      article: { status: "conflict" },
    });
    expect(events.some((event) => event.event_type === "manual_publish_requested")).toBe(false);
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("detects an edit made during the atomic claim and stops before Ghost", async () => {
    let current = {
      ...approvedArticle(),
      status: "scheduled",
      scheduled_publish_at: "2026-09-17T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [approvalEvent(current)];
    const ghost = ghostSpy();
    const baseStore = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const store = {
      ...baseStore,
      patchArticleAndAppendEvent: async (
        _articleId: string,
        patch: Record<string, unknown>,
        event: Record<string, unknown>,
      ) => {
        const updated = { ...current, ...patch } as Article;
        current = updated;
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
        if (event.event_type === "manual_publish_requested") {
          current = { ...current, body_markdown: `${current.body_markdown}\n\nNaknadna izmena.` } as Article;
        }
        return updated;
      },
    } as unknown as GoogleSheetsStore;

    const result = await new PublicationService(
      store,
      ghost.client,
      config,
      logger,
      new KeyedMutex(),
    ).publishNow(current.article_id, actor);

    expect(result).toMatchObject({
      outcome: "blocked",
      reason: "content_changed",
      article: { status: "conflict" },
    });
    expect(events.filter((event) => event.event_type === "manual_publish_requested")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ event_type: "publication_conflict" });
    expect(ghost.calls).not.toHaveBeenCalled();
  });

  it("resumes a stale trusted manual request instead of restoring tomorrow's schedule", async () => {
    let current = {
      ...approvedArticle(),
      status: "publishing",
      scheduled_publish_at: "2026-09-17T08:00:00.000Z",
      updated_at: "2026-09-16T08:00:00.000Z",
    } as Article;
    current.content_hash = articleContentHash(current);
    const events: SheetRecord[] = [
      approvalEvent(current),
      {
        __rowNumber: 3,
        event_id: "manual-request-1",
        article_id: current.article_id,
        event_type: "manual_publish_requested",
        from_status: "scheduled",
        to_status: "publishing",
        actor_type: "telegram_user",
        actor_id: "42",
        provider: "telegram",
        provider_object_id: "telegram:message:-100:10",
        payload_json: JSON.stringify({ hash: articleContentHash(current) }),
      },
    ];
    const store = mutablePublicationStore(() => current, (next) => { current = next; }, events);
    const ghost = {
      findPostBySlug: vi.fn(async () => undefined),
      readCurrentUser: vi.fn(async () => undefined),
      createPost: vi.fn(async () => draftPost(current)),
      readPost: vi.fn(async () => draftPost(current)),
      updatePost: vi.fn(async () => publishedPost(current)),
    } as unknown as GhostAdminClient;
    const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<link rel="canonical" href="${publicUrl}">`, { status: 200 }),
      ),
    );

    try {
      await new PublicationService(
        store,
        ghost,
        config,
        logger,
        new KeyedMutex(),
        () => new Date("2026-09-16T13:00:00.000Z"),
      ).runOnce();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(current.status).toBe("published");
    expect(current.scheduled_publish_at).toBe("2026-09-17T08:00:00.000Z");
    expect(events.some((event) => event.event_type === "publishing_recovered")).toBe(false);
    expect(events.some((event) => event.event_type === "publication_rescheduled")).toBe(false);
  });
});

function mutablePublicationStore(
  read: () => Article,
  write: (article: Article) => void,
  events: SheetRecord[],
): GoogleSheetsStore {
  return {
    getSettings: async () => enabledSettings(),
    listArticles: async () => [{ ...read() }],
    findArticle: async () => read(),
    listEvents: async () => events,
    patchArticle: async (_id: string, patch: Record<string, unknown>) => {
      const updated = { ...read(), ...patch } as Article;
      write(updated);
      return updated;
    },
    appendEvent: async (event: Record<string, unknown>) => {
      events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
    },
    patchArticleAndAppendEvent: async (
      _id: string,
      patch: Record<string, unknown>,
      event: Record<string, unknown>,
    ) => {
      const updated = { ...read(), ...patch } as Article;
      write(updated);
      if (!events.some((existing) => existing.event_id === event.event_id)) {
        events.push({ ...event, __rowNumber: events.length + 2 } as SheetRecord);
      }
      return updated;
    },
  } as unknown as GoogleSheetsStore;
}

function draftPost(article: Article) {
  return {
    id: "ghost-post-manual",
    title: article.title,
    slug: "kako-izabrati-igraonicu-rs",
    status: "draft" as const,
    url: "https://example.com/internal/ghost-post-manual/",
    updated_at: "2026-09-16T13:01:00.000Z",
    published_at: null,
  };
}

function publishedPost(article: Article) {
  return {
    ...draftPost(article),
    status: "published" as const,
    updated_at: "2026-09-16T13:02:00.000Z",
    published_at: "2026-09-16T13:02:00.000Z",
  };
}

describe("verifyPublicPage", () => {
  const publicUrl = "https://example.com/rs/blog/kako-izabrati-igraonicu";

  it.each([
    {
      name: "an exact canonical with rel before href",
      html: `<link rel="canonical" href="${publicUrl}">`,
    },
    {
      name: "a relative canonical with href before rel",
      html: '<link href="/rs/blog/kako-izabrati-igraonicu" rel="alternate canonical">',
    },
    {
      name: "a mixed-case canonical token and attributes",
      html: '<LINK HREF="/rs/blog/kako-izabrati-igraonicu" REL="alternate CANONICAL">',
    },
  ])("accepts $name", async ({ html }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          url: publicUrl,
          text: async () => `<html><head>${html}</head></html>`,
        }) as Response,
      ),
    );

    try {
      await expect(verifyPublicPage(publicUrl)).resolves.toEqual({
        ok: true,
        status: 200,
        message: "Public page verified",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a page without a canonical link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          url: publicUrl,
          text: async () => "<html><head><title>Article</title></head></html>",
        }) as Response,
      ),
    );

    try {
      await expect(verifyPublicPage(publicUrl)).resolves.toEqual({
        ok: false,
        status: 200,
        message: "Canonical link missing",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a page with multiple canonical links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          url: publicUrl,
          text: async () => [
            `<link rel="canonical" href="${publicUrl}">`,
            `<link href="${publicUrl}" rel="canonical">`,
          ].join(""),
        }) as Response,
      ),
    );

    try {
      await expect(verifyPublicPage(publicUrl)).resolves.toEqual({
        ok: false,
        status: 200,
        message: "Multiple canonical links",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a mismatched canonical URL", async () => {
    const canonicalUrl = "https://example.com/rs/blog/druga-igraonica";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          url: publicUrl,
          text: async () => `<link href="${canonicalUrl}" rel="canonical">`,
        }) as Response,
      ),
    );

    try {
      await expect(verifyPublicPage(publicUrl)).resolves.toEqual({
        ok: false,
        status: 200,
        message: `Canonical mismatch: ${canonicalUrl}`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a redirected final response URL", async () => {
    const redirectedUrl = "https://example.com/rs/blog/druga-igraonica";
    const text = vi.fn(async () => `<link href="${redirectedUrl}" rel="canonical">`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          url: redirectedUrl,
          text,
        }) as unknown as Response,
      ),
    );

    try {
      await expect(verifyPublicPage(publicUrl)).resolves.toEqual({
        ok: false,
        status: 200,
        message: `Public URL redirected to ${redirectedUrl}`,
      });
      expect(text).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
