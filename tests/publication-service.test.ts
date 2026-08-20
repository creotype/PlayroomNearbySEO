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

    expect(atomicWrites).toHaveLength(1);
    const atomicWrite = atomicWrites[0]!;
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

    expect(atomicWrites).toHaveLength(1);
    expect(atomicWrites[0]?.patch).toMatchObject({
      status: "failed_publish",
    });
    expect(atomicWrites[0]?.event).toMatchObject({
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

  it("atomically records a publication conflict and its audit event", async () => {
    let current = approvedArticle();
    const events: SheetRecord[] = [
      {
        ...approvalEvent(current),
        payload_json: JSON.stringify({ hash: "stale-approved-hash" }),
      },
    ];
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
      status: "conflict",
      qa_blockers: "changed_after_approval",
      manual_required: true,
    });
    expect(atomicWrites[0]?.event).toMatchObject({
      article_id: current.article_id,
      event_type: "publication_conflict",
      from_status: "approved",
      to_status: "conflict",
      provider: "ghost",
    });
    expect(
      patchArticle.mock.calls.some(([, patch]) => patch.status === "conflict"),
    ).toBe(false);
    expect(
      appendEvent.mock.calls.some(([event]) => event.event_type === "publication_conflict"),
    ).toBe(false);
    expect(current.status).toBe("conflict");
    expect(ghost.calls).not.toHaveBeenCalled();
  });
});

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
