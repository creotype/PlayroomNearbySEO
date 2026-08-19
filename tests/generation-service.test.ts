import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { CellValue, SheetRecord } from "../src/domain/article.js";
import type { OpenAiArticleGenerator } from "../src/generation/openai-generator.js";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import {
  GenerationService,
  manualGenerationIsEnabled,
  manualRequestIds,
} from "../src/services/generation-service.js";
import { QualityGate } from "../src/services/quality-gate.js";

const config: AppConfig = {
  nodeEnv: "test",
  spreadsheetId: "sheet",
  telegramBotToken: "123456789:abcdefghijklmnopqrstuvwxyz",
  ghostAdminUrl: "https://example.com/internal",
  ghostAdminApiKey: "abcdef:0123456789abcdef",
  ghostApiVersion: "v5.0",
  openAiApiKey: "sk-test-abcdefghijklmnopqrstuvwxyz",
  openAiModel: "gpt-5-mini",
  targetEnvironment: "staging",
  port: 8080,
  logLevel: "silent",
  pollIntervalMs: 15_000,
  dryRun: true,
  allowGhostPublish: false,
  allowTelegramGeneration: true,
};

const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
const allowedInternalUrl = "https://example.com/rs";

function validGeneratedBody(): string {
  return `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n[Playroom vodič](${allowedInternalUrl})`;
}

function settings(overrides: Record<string, CellValue> = {}): Map<string, CellValue> {
  return new Map<string, CellValue>([
    ["default_locale", "sr"],
    ["enabled_locales", "sr,en"],
    ["ru_enabled", false],
    ["generation_enabled", false],
    ["telegram_generation_enabled", true],
    ["default_article_length_words", 1_200],
    ["timezone", "Europe/Belgrade"],
    ...Object.entries(overrides),
  ]);
}

function setup(options: {
  settings?: Map<string, CellValue>;
  keywords?: SheetRecord[];
  articles?: SheetRecord[];
  generatorError?: Error;
  qaBlockers?: string[];
  generatedOverrides?: Record<string, unknown>;
  links?: SheetRecord[];
  workflowMutex?: KeyedMutex;
} = {}) {
  const keywordRows = options.keywords ?? [];
  const articleRows = options.articles ?? [];
  const events: SheetRecord[] = [];
  const generate = vi.fn(async () => {
    if (options.generatorError) throw options.generatorError;
    return {
      title: "Kako izabrati igraonicu u Beogradu",
      slug: "kako-izabrati-igraonicu-u-beogradu",
      excerpt: "Praktičan vodič za roditelje koji biraju igraonicu u Beogradu.",
      seo_title: "Kako izabrati igraonicu u Beogradu",
      meta_description: "Praktični saveti za izbor igraonice u Beogradu, sa pitanjima o uslovima, programu i organizaciji proslave.",
      body_markdown: validGeneratedBody(),
      tags: ["rs"],
      source_urls: ["https://example.com/source"],
      internal_links: [allowedInternalUrl],
      quality_score: 9,
      qa_blockers: options.qaBlockers ?? [],
      ...options.generatedOverrides,
    };
  });
  const store = {
    getSettings: async () => options.settings ?? settings(),
    listLinks: async () =>
      options.links ?? [
        {
          __rowNumber: 2,
          environment: "staging",
          locale: "sr",
          url: "https://example.com/rs",
          status: "active",
          allow_internal_link: true,
        },
        {
          __rowNumber: 3,
          environment: "staging",
          locale: "en",
          url: "https://example.com/en",
          status: "active",
          allow_internal_link: true,
        },
      ],
    listGuardrails: async () => [],
    listKeywords: async (statuses?: readonly string[]) =>
      keywordRows.filter((row) => !statuses || statuses.includes(String(row.status))),
    findKeyword: async (keywordId: string) =>
      keywordRows.find((row) => String(row.keyword_id).toLowerCase() === keywordId.toLowerCase()),
    appendKeyword: async (values: Record<string, CellValue>) => {
      keywordRows.push({ __rowNumber: keywordRows.length + 2, ...values });
    },
    appendKeywordAndEvent: async (
      values: Record<string, CellValue>,
      event: Record<string, CellValue>,
    ) => {
      keywordRows.push({ __rowNumber: keywordRows.length + 2, ...values });
      events.push({ __rowNumber: events.length + 2, ...event });
    },
    patchKeyword: async (keywordId: string, patch: Record<string, CellValue>) => {
      const keyword = keywordRows.find((row) => row.keyword_id === keywordId);
      if (!keyword) throw new Error(`Missing keyword ${keywordId}`);
      Object.assign(keyword, patch);
    },
    patchKeywordAndAppendEvent: async (
      keywordId: string,
      patch: Record<string, CellValue>,
      event: Record<string, CellValue>,
    ) => {
      const keyword = keywordRows.find((row) => row.keyword_id === keywordId);
      if (!keyword) throw new Error(`Missing keyword ${keywordId}`);
      Object.assign(keyword, patch);
      if (!events.some((existing) => existing.event_id === event.event_id)) {
        events.push({ __rowNumber: events.length + 2, ...event });
      }
    },
    findArticle: async (articleId: string) =>
      articleRows.find((row) => String(row.article_id).toLowerCase() === articleId.toLowerCase()),
    appendArticle: async (values: Record<string, CellValue>) => {
      articleRows.push({ __rowNumber: articleRows.length + 2, ...values });
    },
    patchArticleAndAppendEvent: async (
      articleId: string,
      patch: Record<string, CellValue>,
      event: Record<string, CellValue>,
    ) => {
      const article = articleRows.find((row) => row.article_id === articleId);
      if (!article) throw new Error(`Missing article ${articleId}`);
      Object.assign(article, patch);
      if (!events.some((existing) => existing.event_id === event.event_id)) {
        events.push({ __rowNumber: events.length + 2, ...event });
      }
      return article;
    },
    listEvents: async (articleId: string) => events.filter((event) => event.article_id === articleId),
    appendEvent: async (event: Record<string, CellValue>) => {
      events.push({ __rowNumber: events.length + 2, ...event });
    },
  };
  const typedStore = store as unknown as GoogleSheetsStore;
  const service = new GenerationService(
    typedStore,
    { generate } as unknown as OpenAiArticleGenerator,
    config,
    logger,
    new QualityGate(typedStore, config),
    options.workflowMutex,
  );
  return { service, keywordRows, articleRows, events, generate };
}

const request = {
  keyword: "igraonice za decu Beograd",
  actorId: 42,
  actorName: "Owner",
  providerObjectId: "message:-5484259760:100",
};

describe("manual generation requests", () => {
  it("queues one durable assigned request and reserves stable IDs", async () => {
    const test = setup();
    const result = await test.service.requestManualGeneration(request);
    const ids = manualRequestIds(request.providerObjectId);
    expect(result).toMatchObject({ outcome: "queued", ...ids, locale: "sr" });
    expect(test.keywordRows).toHaveLength(1);
    expect(test.keywordRows[0]).toMatchObject({
      keyword_id: ids.keywordId,
      article_id: ids.articleId,
      locale: "sr",
      status: "assigned",
      source: `telegram_manual:${request.providerObjectId}`,
    });
    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.event_type).toBe("generation_requested");
  });

  it("is idempotent for repeated and parallel Telegram delivery", async () => {
    const test = setup();
    const [first, second] = await Promise.all([
      test.service.requestManualGeneration(request),
      test.service.requestManualGeneration(request),
    ]);
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("already_queued");
    expect(test.keywordRows).toHaveLength(1);
    expect(test.events.filter((event) => event.event_type === "generation_requested")).toHaveLength(1);
  });

  it("deduplicates the same normalized keyword from a new message", async () => {
    const test = setup();
    await test.service.requestManualGeneration(request);
    const duplicate = await test.service.requestManualGeneration({
      ...request,
      keyword: "  IGRAONICE   ZA DECU beograd ",
      providerObjectId: "message:-5484259760:101",
    });
    expect(duplicate.outcome).toBe("already_queued");
    expect(test.keywordRows).toHaveLength(1);
  });

  it("deduplicates concurrent different messages for the same normalized keyword", async () => {
    const test = setup();
    const [first, second] = await Promise.all([
      test.service.requestManualGeneration(request),
      test.service.requestManualGeneration({
        ...request,
        keyword: "IGRAONICE   ZA DECU BEOGRAD",
        providerObjectId: "message:-5484259760:999",
      }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["already_queued", "queued"]);
    expect(test.keywordRows).toHaveLength(1);
  });

  it("uses an explicit enabled locale and rejects disabled RU", async () => {
    const test = setup();
    const english = await test.service.requestManualGeneration({
      ...request,
      locale: "en",
      providerObjectId: "message:-5484259760:102",
    });
    const russian = await test.service.requestManualGeneration({
      ...request,
      locale: "ru",
      providerObjectId: "message:-5484259760:103",
    });
    expect(english).toMatchObject({ outcome: "queued", locale: "en" });
    expect(russian).toEqual({ outcome: "blocked", reason: "ru_disabled", locale: "ru" });
  });

  it("fails closed when either manual generation gate is off", async () => {
    const sheetOff = setup({ settings: settings({ telegram_generation_enabled: false }) });
    expect((await sheetOff.service.requestManualGeneration(request)).outcome).toBe("blocked");
    expect(sheetOff.keywordRows).toHaveLength(0);
    expect(manualGenerationIsEnabled({ allowTelegramGeneration: false }, settings())).toBe(false);
  });

  it("caps the number of active manual requests", async () => {
    const test = setup();
    for (let index = 0; index < 3; index += 1) {
      expect(
        await test.service.requestManualGeneration({
          ...request,
          keyword: `pending keyword ${index}`,
          providerObjectId: `message:-5484259760:${index}`,
        }),
      ).toMatchObject({ outcome: "queued" });
    }
    expect(await test.service.requestManualGeneration(request)).toMatchObject({
      outcome: "blocked",
      reason: "queue_full",
    });
    expect(test.keywordRows).toHaveLength(3);
  });
});

describe("manual generation worker", () => {
  it("processes only assigned Telegram requests while scheduled generation is disabled", async () => {
    const scheduled = {
      __rowNumber: 2,
      keyword_id: "KW-SCHEDULED",
      article_id: "",
      locale: "sr",
      primary_keyword: "scheduled keyword",
      status: "ready",
      source: "manual_test",
    } as SheetRecord;
    const test = setup({ keywords: [scheduled] });
    const queued = await test.service.requestManualGeneration(request);
    expect(queued.outcome).toBe("queued");
    const ids = manualRequestIds(request.providerObjectId);
    const manual = test.keywordRows.find((row) => row.keyword_id === ids.keywordId)!;
    await test.service.runManualOnce();
    await test.service.runOnce();
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(manual.status).toBe("used");
    expect(scheduled.status).toBe("ready");
    expect(test.articleRows).toHaveLength(1);
    expect(test.articleRows[0]).toMatchObject({
      article_id: ids.articleId,
      status: "needs_review",
      qa_status: "pass",
      manual_required: false,
    });
  });

  it("requires explicit human clearance when model QA reports a semantic defect", async () => {
    const test = setup({ qaBlockers: ["missing_authoritative_source"] });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    await test.service.runManualOnce();
    expect(test.articleRows[0]).toMatchObject({
      qa_status: "fail",
      qa_blockers: "missing_authoritative_source",
      manual_required: true,
    });
  });

  it("runs fresh deterministic QA before appending an initially generated article", async () => {
    const malformedBody = `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n[Playroom].(${allowedInternalUrl})\n[Izvor](https://example.org/story)`;
    const test = setup({
      generatedOverrides: {
        body_markdown: malformedBody,
        source_urls: ["https://example.org/story?utm_source=openai"],
      },
    });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    await test.service.runManualOnce();
    expect(String(test.articleRows[0]?.qa_blockers)).toContain("malformed_markdown_link");
    expect(String(test.articleRows[0]?.qa_blockers)).toContain("external_url_in_body");
    expect(String(test.articleRows[0]?.qa_blockers)).toContain("tracking_parameters_in_source_url");
    expect(test.articleRows[0]?.qa_status).toBe("fail");
  });

  it("moves a failed request to paused without a retry loop", async () => {
    const ids = manualRequestIds(request.providerObjectId);
    const test = setup({ generatorError: new Error("upstream failed") });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    const manual = test.keywordRows.find((row) => row.keyword_id === ids.keywordId)!;
    await test.service.runManualOnce();
    await test.service.runManualOnce();
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(manual.status).toBe("paused");
    expect(test.articleRows).toHaveLength(0);
  });

  it("rejects a Sheet-injected manual row without a signed Telegram request", async () => {
    const manual = {
      __rowNumber: 2,
      keyword_id: "KW-LEGACY",
      article_id: "",
      locale: "sr",
      primary_keyword: request.keyword,
      status: "assigned",
      source: "telegram_manual:message:-5484259760:200",
    } as SheetRecord;
    const test = setup({ keywords: [manual] });
    await test.service.runManualOnce();
    expect(String(manual.article_id)).toMatch(/^SEO-/);
    expect(test.generate).not.toHaveBeenCalled();
    expect(manual.status).toBe("paused");
    expect(test.events).toContainEqual(
      expect.objectContaining({ event_type: "generation_blocked", message: "invalid_manual_request" }),
    );
    expect(test.articleRows).toHaveLength(0);
  });

  it("rejects a queued request if an editor tampers with its signed keyword", async () => {
    const test = setup();
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    test.keywordRows[0]!.primary_keyword = "tampered high-cost keyword";
    await test.service.runManualOnce();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.keywordRows[0]?.status).toBe("paused");
    expect(test.articleRows).toHaveLength(0);
  });

  it("rechecks locale settings after enqueue and before model execution", async () => {
    const liveSettings = settings();
    const test = setup({ settings: liveSettings });
    const queued = await test.service.requestManualGeneration({
      ...request,
      locale: "en",
      providerObjectId: "message:-5484259760:201",
    });
    expect(queued.outcome).toBe("queued");
    liveSettings.set("enabled_locales", "sr");
    await test.service.runManualOnce();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.keywordRows[0]?.status).toBe("paused");
    expect(test.events.some((event) => event.event_type === "generation_blocked")).toBe(true);
  });
});

const regenerationRequest = {
  articleId: "SEO-REV-1",
  feedback: "Ispravi izvore i linkove",
  actorId: 42,
  actorName: "Owner",
  providerObjectId: "message:-5484259760:500",
};

function reviewArticle(overrides: Record<string, CellValue> = {}): SheetRecord {
  return {
    __rowNumber: 2,
    article_id: regenerationRequest.articleId,
    keyword_id: "KW-REV-1",
    locale: "sr",
    status: "needs_review",
    primary_keyword: "igraonice za decu Beograd",
    search_intent: "informational",
    article_type: "guide",
    topic: "igraonice za decu Beograd",
    title: "Stari naslov igraonice Beograd",
    slug: "stari-naslov-igraonice-beograd",
    excerpt: "Stari opis članka koji će biti bezbedno zamenjen tek posle uspešne generacije.",
    seo_title: "Stari naslov igraonice u Beogradu",
    meta_description:
      "Stari kompletan opis igraonica u Beogradu sa praktičnim pitanjima za roditelje i staratelje.",
    body_markdown: validGeneratedBody(),
    tags: "rs",
    source_urls: "https://example.com/source",
    internal_links: allowedInternalUrl,
    quality_score: 8,
    qa_status: "fail",
    qa_blockers: "missing_authoritative_source",
    manual_required: true,
    revision_count: 0,
    content_hash: "old-hash",
    telegram_message_id: 12,
    approved_by: "should-clear",
    approved_at: "should-clear",
    ghost_post_id: "should-clear",
    public_url: "should-clear",
    ...overrides,
  };
}

describe("article regeneration", () => {
  it("replaces the same row only after successful generation and records one atomic revision", async () => {
    const original = reviewArticle();
    const test = setup({ articles: [original] });

    const result = await test.service.regenerateArticle(regenerationRequest);

    expect(result.outcome).toBe("regenerated");
    expect(test.articleRows).toHaveLength(1);
    expect(test.articleRows[0]).toMatchObject({
      article_id: regenerationRequest.articleId,
      title: "Kako izabrati igraonicu u Beogradu",
      status: "needs_review",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      revision_count: 1,
      content_hash: "",
      telegram_message_id: 12,
      approved_by: "",
      approved_at: "",
      ghost_post_id: "",
      public_url: "",
    });
    expect(test.events).toContainEqual(
      expect.objectContaining({
        event_type: "regenerated",
        article_id: regenerationRequest.articleId,
        provider_object_id: `telegram:${regenerationRequest.providerObjectId}`,
      }),
    );
  });

  it("is idempotent for a repeated Telegram delivery", async () => {
    const test = setup({ articles: [reviewArticle()] });
    expect((await test.service.regenerateArticle(regenerationRequest)).outcome).toBe("regenerated");
    expect((await test.service.regenerateArticle(regenerationRequest)).outcome).toBe(
      "already_regenerated",
    );
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.events.filter((event) => event.event_type === "regenerated")).toHaveLength(1);
    expect(test.articleRows).toHaveLength(1);
  });

  it("records an explicit system actor for an administrative repair", async () => {
    const test = setup({ articles: [reviewArticle()] });

    await test.service.regenerateArticle({
      ...regenerationRequest,
      actorId: "qa-repair",
      actorName: "QA repair",
      actorType: "system",
      provider: "system",
      providerObjectId: "repair-v2",
    });

    expect(test.events).toContainEqual(
      expect.objectContaining({
        event_type: "regenerated",
        actor_type: "system",
        actor_id: "qa-repair",
        provider: "system",
        provider_object_id: "system:repair-v2",
      }),
    );
  });

  it("uses the shared article mutex before reading or replacing the draft", async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = mutex.runExclusive(regenerationRequest.articleId, async () => {
      entered();
      await hold;
    });
    await lockEntered;
    const test = setup({ articles: [reviewArticle()], workflowMutex: mutex });

    const regeneration = test.service.regenerateArticle(regenerationRequest);
    await Promise.resolve();
    expect(test.generate).not.toHaveBeenCalled();

    release();
    await lock;
    await regeneration;
    expect(test.generate).toHaveBeenCalledTimes(1);
  });

  it("preserves the old draft when OpenAI fails", async () => {
    const original = reviewArticle();
    const oldBody = String(original.body_markdown);
    const test = setup({ articles: [original], generatorError: new Error("upstream failed") });

    await expect(test.service.regenerateArticle(regenerationRequest)).rejects.toThrow("upstream failed");

    expect(test.articleRows[0]?.body_markdown).toBe(oldBody);
    expect(test.articleRows[0]?.revision_count).toBe(0);
    expect(test.events).toHaveLength(0);
  });

  it("refuses approved and later workflow states before calling OpenAI", async () => {
    const test = setup({ articles: [reviewArticle({ status: "approved" })] });
    await expect(test.service.regenerateArticle(regenerationRequest)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "invalid_status",
      article: { status: "approved" },
    });
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.articleRows[0]?.body_markdown).toBe(validGeneratedBody());
  });

  it("rechecks locale and active internal-link gates before spending an OpenAI call", async () => {
    const localeOff = setup({
      articles: [reviewArticle()],
      settings: settings({ enabled_locales: "en" }),
    });
    await expect(localeOff.service.regenerateArticle(regenerationRequest)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "locale_disabled",
    });
    expect(localeOff.generate).not.toHaveBeenCalled();

    const linksOff = setup({ articles: [reviewArticle()], links: [] });
    await expect(linksOff.service.regenerateArticle(regenerationRequest)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "no_internal_links",
    });
    expect(linksOff.generate).not.toHaveBeenCalled();
  });

  it("keeps semantic model blockers as an explicit human gate", async () => {
    const test = setup({
      articles: [reviewArticle()],
      qaBlockers: ["missing_authoritative_source"],
    });
    await test.service.regenerateArticle(regenerationRequest);
    expect(test.articleRows[0]).toMatchObject({
      qa_status: "fail",
      qa_blockers: "missing_authoritative_source",
      manual_required: true,
    });
  });
});
