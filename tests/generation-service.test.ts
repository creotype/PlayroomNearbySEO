import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { articleContentHash, type CellValue, type SheetRecord } from "../src/domain/article.js";
import type { OpenAiArticleGenerator } from "../src/generation/openai-generator.js";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import {
  GenerationService,
  manualGenerationIsEnabled,
} from "../src/services/generation-service.js";
import type { HeroImageService } from "../src/services/hero-image-service.js";
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
  heroImages?: HeroImageService;
  beforeKeywordClaim?: (keyword: SheetRecord) => void;
  onGenerate?: () => void | Promise<void>;
} = {}) {
  const keywordRows = options.keywords ?? [];
  const articleRows = options.articles ?? [];
  const events: SheetRecord[] = [];
  const listKeywords = vi.fn(async (
    statuses?: readonly string[],
    listOptions: { includeIncomplete?: boolean } = {},
  ) =>
    keywordRows
      .filter((row) => listOptions.includeIncomplete || Boolean(String(row.keyword_id ?? "").trim()))
      .filter((row) => !statuses || statuses.includes(String(row.status))));
  const listArticles = vi.fn(async (statuses?: readonly string[]) =>
    articleRows
      .filter((row) => Boolean(String(row.article_id ?? "").trim()))
      .filter((row) => !statuses || statuses.includes(String(row.status))));
  const patchKeywordAndAppendEvent = vi.fn(async (
    keywordId: string,
    patch: Record<string, CellValue>,
    event: Record<string, CellValue>,
    expected?: Record<string, CellValue>,
  ) => {
    const keyword = keywordRows.find((row) => row.keyword_id === keywordId);
    if (!keyword) throw new Error(`Missing keyword ${keywordId}`);
    options.beforeKeywordClaim?.(keyword);
    if (
      expected &&
      Object.entries(expected).some(([field, value]) => String(keyword[field] ?? "").trim() !== String(value ?? "").trim())
    ) {
      return false;
    }
    Object.assign(keyword, patch);
    if (!events.some((existing) => existing.event_id === event.event_id)) {
      events.push({ __rowNumber: events.length + 2, ...event });
    }
    return true;
  });
  const generate = vi.fn(async () => {
    if (options.generatorError) throw options.generatorError;
    await options.onGenerate?.();
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
    listKeywords,
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
    patchKeywordAndAppendEvent,
    listArticles,
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
  const heroImages = options.heroImages ?? ({
    ensureForArticle: async () => ({
      url: "https://example.com/content/images/generated-hero.webp",
      alt: "Tematska ilustracija: izbor igraonice",
    }),
  } as unknown as HeroImageService);
  const service = new GenerationService(
    typedStore,
    { generate } as unknown as OpenAiArticleGenerator,
    config,
    logger,
    new QualityGate(typedStore, config),
    options.workflowMutex,
    heroImages,
  );
  return {
    service,
    keywordRows,
    articleRows,
    events,
    generate,
    listKeywords,
    listArticles,
    patchKeywordAndAppendEvent,
  };
}

const request = {
  actorId: 42,
  actorName: "Owner",
  providerObjectId: "message:-5484259760:100",
};

function readyKeyword(overrides: Record<string, CellValue> = {}): SheetRecord {
  return {
    __rowNumber: 2,
    keyword_id: "KW-READY-1",
    article_id: "",
    locale: "sr",
    primary_keyword: "igraonice za decu Beograd",
    secondary_keywords: "",
    cluster: "playrooms",
    geo_target: "Belgrade, Serbia",
    search_intent: "informational",
    article_type: "guide",
    priority: 10,
    status: "ready",
    topic_angle: "Kako izabrati igraonicu",
    source: "keyword_research",
    ...overrides,
  } as SheetRecord;
}

function activeReview(overrides: Record<string, CellValue> = {}): SheetRecord {
  return {
    __rowNumber: 14,
    article_id: "SEO-ACTIVE-REVIEW",
    keyword_id: "KW-ACTIVE-REVIEW",
    locale: "sr",
    status: "needs_review",
    title: "Aktivna revizija",
    slug: "aktivna-revizija",
    body_markdown: "draft",
    telegram_message_id: 75,
    ...overrides,
  };
}

describe("manual generation requests", () => {
  it.each(["needs_review", "failed_qa"])(
    "blocks before claiming when one %s article is awaiting a decision",
    async (status) => {
      const keyword = readyKeyword();
      const test = setup({
        keywords: [keyword],
        articles: [activeReview({ status })],
      });

      await expect(test.service.requestManualGeneration(request)).resolves.toEqual({
        outcome: "blocked",
        reason: "active_review_exists",
        articleId: "SEO-ACTIVE-REVIEW",
        rowNumber: 14,
        telegramMessageId: 75,
        activeCount: 1,
      });
      expect(test.listKeywords).toHaveBeenCalledBefore(test.listArticles);
      expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
      expect(keyword).toMatchObject({ status: "ready", article_id: "" });
      expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
      expect(test.events).toHaveLength(0);
      expect(test.generate).not.toHaveBeenCalled();
    },
  );

  it("fails closed and reports every Sheet row when multiple review articles already exist", async () => {
    const keyword = readyKeyword();
    const test = setup({
      keywords: [keyword],
      articles: [
        activeReview({ __rowNumber: 19, article_id: "SEO-REVIEW-LATER", telegram_message_id: 91 }),
        activeReview({ __rowNumber: 4, article_id: "SEO-REVIEW-FIRST", telegram_message_id: 52 }),
      ],
    });

    await expect(test.service.requestManualGeneration(request)).resolves.toEqual({
      outcome: "blocked",
      reason: "multiple_active_reviews",
      articleId: "SEO-REVIEW-FIRST",
      rowNumber: 4,
      telegramMessageId: 52,
      activeCount: 2,
      conflictingRows: [4, 19],
    });
    expect(keyword.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
    expect(test.generate).not.toHaveBeenCalled();
  });

  it("allows the next keyword after the previous article has been approved", async () => {
    const keyword = readyKeyword();
    const test = setup({
      keywords: [keyword],
      articles: [activeReview({ status: "approved" })],
    });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "queued",
      keywordId: "KW-READY-1",
    });
    expect(keyword.status).toBe("assigned");
  });

  it("claims the physically topmost ready row, preserving its keyword identity and source", async () => {
    const physicallyFirst = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-TOP",
      primary_keyword: "prvi ključ u tabeli",
      priority: 1,
      planned_publish_at: "2099-12-31T12:00:00.000Z",
      source: "seo_research_import",
    });
    const numericallyHigherPriority = readyKeyword({
      __rowNumber: 9,
      keyword_id: "KW-HIGH-PRIORITY",
      primary_keyword: "kasniji ključ u tabeli",
      priority: 999,
      source: "another_import",
    });
    // Deliberately return the lower Sheet row second: selection must use __rowNumber,
    // not array order and not the numeric priority column.
    const test = setup({ keywords: [numericallyHigherPriority, physicallyFirst] });
    const result = await test.service.requestManualGeneration(request);

    expect(result).toMatchObject({
      outcome: "queued",
      keywordId: "KW-TOP",
      locale: "sr",
      keyword: "prvi ključ u tabeli",
    });
    expect(result.outcome === "blocked" ? "" : result.articleId).toMatch(/^SEO-/);
    expect(physicallyFirst).toMatchObject({
      keyword_id: "KW-TOP",
      status: "assigned",
      source: "seo_research_import",
    });
    expect(String(physicallyFirst.article_id)).toMatch(/^SEO-/);
    expect(numericallyHigherPriority).toMatchObject({
      keyword_id: "KW-HIGH-PRIORITY",
      status: "ready",
      article_id: "",
      source: "another_import",
    });
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({
      article_id: physicallyFirst.article_id,
      event_type: "generation_requested",
      to_status: "assigned",
      actor_type: "telegram_user",
      actor_id: "42",
      provider: "telegram",
      provider_object_id: request.providerObjectId,
    });
    expect(JSON.parse(String(test.events[0]?.payload_json))).toMatchObject({
      request_kind: "sheet_queue",
      keyword_id: "KW-TOP",
      article_id: physicallyFirst.article_id,
      row_number: 3,
      locale: "sr",
      keyword: "prvi ključ u tabeli",
    });
    expect(JSON.parse(String(test.events[0]?.payload_json)).signature).toMatch(/^[a-f0-9]{64}$/);
    expect(test.patchKeywordAndAppendEvent).toHaveBeenCalledTimes(1);
  });

  it("reports a missing keyword_id on the physically topmost ready row instead of skipping it", async () => {
    const brokenTopRow = readyKeyword({
      __rowNumber: 4,
      keyword_id: "",
      primary_keyword: "ključ bez identifikatora",
    });
    const validLowerRow = readyKeyword({
      __rowNumber: 8,
      keyword_id: "KW-VALID-LOWER",
      primary_keyword: "validan ključ niže u tabeli",
    });
    const test = setup({ keywords: [validLowerRow, brokenTopRow] });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "invalid_keyword_row",
      rowNumber: 4,
      locale: "sr",
      invalidFields: ["keyword_id"],
    });
    expect(test.listKeywords).toHaveBeenCalledWith(undefined, { includeIncomplete: true });
    expect(brokenTopRow.status).toBe("ready");
    expect(validLowerRow.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
  });

  it("returns every invalid field from one ready row so the operator can fix it in one pass", async () => {
    const broken = readyKeyword({
      __rowNumber: 6,
      keyword_id: "",
      primary_keyword: "x",
      article_id: "SEO-LEFTOVER",
    });
    const test = setup({ keywords: [broken] });

    const result = await test.service.requestManualGeneration(request);

    expect(result).toMatchObject({
      outcome: "blocked",
      reason: "invalid_keyword_row",
      rowNumber: 6,
      locale: "sr",
      articleId: "SEO-LEFTOVER",
    });
    expect(result.outcome === "blocked" ? result.invalidFields : []).toHaveLength(3);
    expect(result.outcome === "blocked" ? result.invalidFields : []).toEqual(
      expect.arrayContaining(["keyword_id", "primary_keyword", "article_id"]),
    );
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("reports every row that shares the selected keyword_id without claiming any of them", async () => {
    const selected = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-DUPLICATE",
      primary_keyword: "prvi duplikat",
    });
    const duplicate = readyKeyword({
      __rowNumber: 9,
      keyword_id: "kw-duplicate",
      primary_keyword: "drugi duplikat",
    });
    const test = setup({ keywords: [duplicate, selected] });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "duplicate_keyword_id",
      keywordId: "KW-DUPLICATE",
      rowNumber: 3,
      conflictingRows: [3, 9],
    });
    expect(selected.status).toBe("ready");
    expect(duplicate.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
  });

  it("identifies a leftover article_id on a ready row", async () => {
    const keyword = readyKeyword({
      __rowNumber: 10,
      keyword_id: "KW-ARTICLE-CONFLICT",
      article_id: "SEO-EXISTING",
    });
    const test = setup({ keywords: [keyword] });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "invalid_keyword_row",
      keywordId: "KW-ARTICLE-CONFLICT",
      rowNumber: 10,
      locale: "sr",
      articleId: "SEO-EXISTING",
      invalidFields: ["article_id"],
    });
    expect(keyword.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("does not overwrite an operator edit made between selection and claim", async () => {
    const keyword = readyKeyword({ __rowNumber: 12, keyword_id: "KW-EDIT-RACE" });
    const test = setup({
      keywords: [keyword],
      beforeKeywordClaim: (current) => {
        current.status = "paused";
      },
    });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "keyword_row_changed",
      keywordId: "KW-EDIT-RACE",
      rowNumber: 12,
    });
    expect(keyword).toMatchObject({ status: "paused", article_id: "" });
    expect(test.events).toHaveLength(0);
  });

  it("is idempotent for repeated and parallel delivery of the same Telegram update", async () => {
    const firstReady = readyKeyword();
    const secondReady = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-READY-2",
      primary_keyword: "drugi ključ",
    });
    const test = setup({ keywords: [firstReady, secondReady] });
    const [first, second] = await Promise.all([
      test.service.requestManualGeneration(request),
      test.service.requestManualGeneration(request),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["already_queued", "queued"]);
    expect(first.outcome === "blocked" ? "" : first.keywordId).toBe("KW-READY-1");
    expect(second.outcome === "blocked" ? "" : second.keywordId).toBe("KW-READY-1");
    expect(firstReady.status).toBe("assigned");
    expect(secondReady.status).toBe("ready");
    expect(test.events.filter((event) => event.event_type === "generation_requested")).toHaveLength(1);
  });

  it("replays the original result after it becomes used without consuming the next row", async () => {
    const firstReady = readyKeyword();
    const secondReady = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-READY-2",
      primary_keyword: "drugi ključ",
    });
    const test = setup({ keywords: [firstReady, secondReady] });

    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    await test.service.runManualOnce();
    const replay = await test.service.requestManualGeneration(request);

    expect(replay).toMatchObject({ outcome: "already_generated", keywordId: "KW-READY-1" });
    expect(firstReady.status).toBe("used");
    expect(secondReady.status).toBe("ready");
    expect(test.generate).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight generation across concurrent Telegram commands", async () => {
    const firstReady = readyKeyword();
    const secondReady = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-READY-2",
      primary_keyword: "drugi ključ",
    });
    const test = setup({ keywords: [secondReady, firstReady] });

    const [first, second] = await Promise.all([
      test.service.requestManualGeneration(request),
      test.service.requestManualGeneration({
        ...request,
        providerObjectId: "message:-5484259760:101",
      }),
    ]);

    expect(first).toMatchObject({ outcome: "queued", keywordId: "KW-READY-1" });
    expect(second).toMatchObject({
      outcome: "blocked",
      reason: "generation_in_progress",
      keywordId: "KW-READY-1",
      rowNumber: 2,
      articleId: first.outcome === "blocked" ? "" : first.articleId,
      activeCount: 1,
    });
    expect(firstReady.status).toBe("assigned");
    expect(secondReady.status).toBe("ready");
    expect(test.events.filter((event) => event.event_type === "generation_requested")).toHaveLength(1);
  });

  it("reports an empty queue without creating a keyword or event", async () => {
    const test = setup({
      keywords: [
        readyKeyword({ status: "paused" }),
        readyKeyword({ __rowNumber: 3, keyword_id: "KW-USED", status: "used" }),
      ],
    });
    await expect(test.service.requestManualGeneration(request)).resolves.toEqual({
      outcome: "blocked",
      reason: "no_ready_keywords",
    });
    expect(test.events).toHaveLength(0);
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("fails closed when either manual generation gate is off", async () => {
    const sheetOff = setup({
      keywords: [readyKeyword()],
      settings: settings({ telegram_generation_enabled: false }),
    });
    expect((await sheetOff.service.requestManualGeneration(request)).outcome).toBe("blocked");
    expect(sheetOff.keywordRows[0]?.status).toBe("ready");
    expect(manualGenerationIsEnabled({ allowTelegramGeneration: false }, settings())).toBe(false);
  });

  it("reports the selected row and allowed locales when its locale is disabled", async () => {
    const keyword = readyKeyword({
      __rowNumber: 8,
      keyword_id: "KW-DE-OFF",
      locale: "de",
    });
    const test = setup({ keywords: [keyword] });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "locale_disabled",
      keywordId: "KW-DE-OFF",
      rowNumber: 8,
      locale: "de",
      allowedLocales: ["sr", "en"],
    });
    expect(keyword.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("reports the selected RU row when Russian generation is disabled", async () => {
    const ruKeyword = readyKeyword({
      __rowNumber: 11,
      keyword_id: "KW-RU-OFF",
      locale: "ru",
    });
    const ruOff = setup({
      keywords: [ruKeyword],
      settings: settings({ enabled_locales: "sr,en,ru", ru_enabled: false }),
    });
    await expect(ruOff.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "ru_disabled",
      keywordId: "KW-RU-OFF",
      rowNumber: 11,
      locale: "ru",
    });
    expect(ruKeyword.status).toBe("ready");
    expect(ruOff.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("reports the selected row and locale when its internal-link inventory is empty", async () => {
    const noLinkKeyword = readyKeyword({
      __rowNumber: 12,
      keyword_id: "KW-NO-LINKS",
      locale: "en",
    });
    const linksOff = setup({ keywords: [noLinkKeyword], links: [] });
    await expect(linksOff.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "no_internal_links",
      keywordId: "KW-NO-LINKS",
      rowNumber: 12,
      locale: "en",
    });
    expect(noLinkKeyword.status).toBe("ready");
    expect(linksOff.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });

  it("returns the existing keyword row when a Telegram delivery conflicts with its signed request", async () => {
    const claimedKeyword = readyKeyword({
      __rowNumber: 13,
      keyword_id: "KW-CONFLICT",
    });
    const nextKeyword = readyKeyword({
      __rowNumber: 14,
      keyword_id: "KW-NEXT-AFTER-CONFLICT",
      primary_keyword: "sledeći ključ posle konflikta",
    });
    const test = setup({ keywords: [claimedKeyword, nextKeyword] });
    const first = await test.service.requestManualGeneration(request);
    expect(first).toMatchObject({ outcome: "queued", keywordId: "KW-CONFLICT" });
    const articleId = first.outcome === "blocked" ? "" : first.articleId;
    test.events[0]!.payload_json = JSON.stringify({ request_kind: "sheet_queue", signature: "tampered" });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "request_conflict",
      keywordId: "KW-CONFLICT",
      rowNumber: 13,
      locale: "sr",
      articleId,
    });
    expect(claimedKeyword.status).toBe("assigned");
    expect(nextKeyword.status).toBe("ready");
    expect(test.patchKeywordAndAppendEvent).toHaveBeenCalledTimes(1);
  });

  it("blocks a manual request behind any existing generation, including a scheduled one", async () => {
    const scheduledInFlight = readyKeyword({
      __rowNumber: 2,
      keyword_id: "KW-SCHEDULED-IN-FLIGHT",
      article_id: "SEO-SCHEDULED-IN-FLIGHT",
      status: "generating",
    });
    const waiting = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-WAITING",
      primary_keyword: "waiting keyword",
    });
    const test = setup({
      keywords: [waiting, scheduledInFlight],
    });

    expect(await test.service.requestManualGeneration(request)).toMatchObject({
      outcome: "blocked",
      reason: "generation_in_progress",
      keywordId: "KW-SCHEDULED-IN-FLIGHT",
      rowNumber: 2,
      articleId: "SEO-SCHEDULED-IN-FLIGHT",
      activeCount: 1,
    });
    expect(scheduledInFlight.status).toBe("generating");
    expect(waiting.status).toBe("ready");
    expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
  });

  it("points to the active review before a legacy in-flight request waiting behind it", async () => {
    const inFlight = readyKeyword({
      keyword_id: "KW-WAITING-BEHIND-REVIEW",
      article_id: "SEO-WAITING-BEHIND-REVIEW",
      status: "assigned",
    });
    const review = activeReview({ article_id: "SEO-REVIEW-FIRST" });
    const test = setup({ keywords: [inFlight], articles: [review] });

    await expect(test.service.requestManualGeneration(request)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "active_review_exists",
      articleId: "SEO-REVIEW-FIRST",
      rowNumber: review.__rowNumber,
    });
    expect(inFlight.status).toBe("assigned");
    expect(test.patchKeywordAndAppendEvent).not.toHaveBeenCalled();
  });
});

describe("single active article worker invariant", () => {
  it("does not let the scheduled worker generate a ready row while an article awaits review", async () => {
    const keyword = readyKeyword();
    const review = activeReview();
    const test = setup({
      settings: settings({ generation_enabled: true }),
      keywords: [keyword],
      articles: [review],
    });

    await test.service.runOnce();

    expect(keyword).toMatchObject({ status: "ready", article_id: "" });
    expect(test.articleRows).toEqual([review]);
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
  });

  it("recovers the keyword transition for the same existing review without generating again", async () => {
    const review = activeReview({ article_id: "SEO-RECOVERY" });
    const olderInFlight = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-OTHER-IN-FLIGHT",
      article_id: "SEO-OTHER-IN-FLIGHT",
      status: "assigned",
    });
    const keyword = readyKeyword({
      __rowNumber: 8,
      keyword_id: "KW-RECOVERY",
      article_id: "SEO-RECOVERY",
      status: "assigned",
    });
    const test = setup({
      settings: settings({ generation_enabled: true }),
      keywords: [keyword, olderInFlight],
      articles: [review],
    });

    await test.service.runOnce();

    expect(keyword.status).toBe("used");
    expect(olderInFlight.status).toBe("assigned");
    expect(test.articleRows).toEqual([review]);
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.events).toContainEqual(
      expect.objectContaining({
        article_id: "SEO-RECOVERY",
        event_type: "generated",
        to_status: "needs_review",
      }),
    );
  });

  it("drains only the top legacy in-flight row before its new review blocks the rest", async () => {
    const topInFlight = readyKeyword({
      __rowNumber: 4,
      keyword_id: "KW-LEGACY-TOP",
      article_id: "SEO-LEGACY-TOP",
      status: "assigned",
    });
    const laterInFlight = readyKeyword({
      __rowNumber: 11,
      keyword_id: "KW-LEGACY-LATER",
      article_id: "SEO-LEGACY-LATER",
      status: "generating",
    });
    const test = setup({
      settings: settings({ generation_enabled: true }),
      keywords: [laterInFlight, topInFlight],
    });

    await test.service.runOnce();

    expect(topInFlight.status).toBe("used");
    expect(laterInFlight.status).toBe("generating");
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.articleRows).toHaveLength(1);
    expect(test.articleRows[0]).toMatchObject({
      article_id: "SEO-LEGACY-TOP",
      status: "needs_review",
    });
  });
});

describe("manual generation worker", () => {
  it("processes a row authorized by its durable signed request event, not by a source prefix", async () => {
    const queuedKeyword = readyKeyword({ source: "seo_research_import" });
    const untouched = readyKeyword({
      __rowNumber: 3,
      keyword_id: "KW-NEXT",
      primary_keyword: "sledeći ključ",
      source: "seo_research_import",
    });
    const test = setup({ keywords: [queuedKeyword, untouched] });
    const queued = await test.service.requestManualGeneration(request);
    expect(queued.outcome).toBe("queued");
    await test.service.runManualOnce();
    await test.service.runOnce();
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(queuedKeyword.status).toBe("used");
    expect(queuedKeyword.source).toBe("seo_research_import");
    expect(untouched.status).toBe("ready");
    expect(test.articleRows).toHaveLength(1);
    expect(test.articleRows[0]).toMatchObject({
      article_id: queuedKeyword.article_id,
      keyword_id: "KW-READY-1",
      status: "needs_review",
      qa_status: "pass",
      manual_required: false,
    });
  });

  it("keeps a signed request valid when the Sheet row moves after claiming", async () => {
    const queuedKeyword = readyKeyword();
    const test = setup({ keywords: [queuedKeyword] });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");

    queuedKeyword.__rowNumber = 27;
    await test.service.runManualOnce();

    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(queuedKeyword.status).toBe("used");
    expect(test.articleRows).toHaveLength(1);
  });

  it("requires explicit human clearance when model QA reports a semantic defect", async () => {
    const test = setup({
      keywords: [readyKeyword()],
      qaBlockers: ["missing_authoritative_source"],
    });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    await test.service.runManualOnce();
    expect(test.articleRows[0]).toMatchObject({
      status: "failed_qa",
      qa_status: "fail",
      qa_blockers: "missing_authoritative_source",
      manual_required: true,
    });
    expect(test.keywordRows[0]?.status).toBe("used");
  });

  it("runs fresh deterministic QA before appending an initially generated article", async () => {
    const malformedBody = `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n[Playroom].(${allowedInternalUrl})\n[Izvor](https://example.org/story)`;
    const test = setup({
      keywords: [readyKeyword()],
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
    expect(test.articleRows[0]?.status).toBe("failed_qa");
    expect(test.articleRows[0]?.qa_status).toBe("fail");
  });

  it("moves a failed request to paused without a retry loop", async () => {
    const keyword = readyKeyword();
    const test = setup({ keywords: [keyword], generatorError: new Error("upstream failed") });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    await test.service.runManualOnce();
    await test.service.runManualOnce();
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(keyword.status).toBe("paused");
    expect(test.articleRows).toHaveLength(0);
  });

  it("does not replay a paid initial attempt after a restart with no committed article", async () => {
    const keyword = readyKeyword();
    const test = setup({ keywords: [keyword] });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    test.events.push({
      __rowNumber: test.events.length + 2,
      event_id: "evt-ambiguous-paid-attempt",
      article_id: String(keyword.article_id),
      event_type: "generation_attempt_started",
    });

    await test.service.runManualOnce();

    expect(test.generate).not.toHaveBeenCalled();
    expect(keyword.status).toBe("paused");
    expect(test.events.some((event) => event.event_type === "generation_failed")).toBe(true);
  });

  it("stores the generated Ghost hero URL and alt text before review", async () => {
    const ensureForArticle = vi.fn(async () => ({
      url: "https://example.com/content/images/generated-hero.webp",
      alt: "Tematska ilustracija: izbor igraonice",
    }));
    const test = setup({
      keywords: [readyKeyword()],
      heroImages: { ensureForArticle } as unknown as HeroImageService,
    });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");

    await test.service.runManualOnce();

    expect(ensureForArticle).toHaveBeenCalledOnce();
    expect(test.articleRows[0]).toMatchObject({
      status: "needs_review",
      feature_image_url: "https://example.com/content/images/generated-hero.webp",
      feature_image_alt: "Tematska ilustracija: izbor igraonice",
    });
  });

  it("pauses generation and creates no review article when hero creation fails", async () => {
    const keyword = readyKeyword();
    const test = setup({
      keywords: [keyword],
      heroImages: {
        ensureForArticle: vi.fn(async () => { throw new Error("image quota exceeded"); }),
      } as unknown as HeroImageService,
    });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");

    await test.service.runManualOnce();

    expect(keyword.status).toBe("paused");
    expect(test.articleRows).toHaveLength(0);
    expect(test.events.at(-1)).toMatchObject({ event_type: "generation_failed" });
    expect(String(test.events.at(-1)?.message)).toContain("Hero image generation/upload failed");
  });

  it("does not treat a legacy source prefix as authorization without a durable request event", async () => {
    const manual = readyKeyword({
      keyword_id: "KW-INJECTED",
      article_id: "SEO-INJECTED",
      status: "assigned",
      source: "telegram_manual:message:-5484259760:200",
    });
    const test = setup({ keywords: [manual] });
    await test.service.runManualOnce();
    expect(test.generate).not.toHaveBeenCalled();
    expect(manual.status).toBe("assigned");
    expect(test.events).toHaveLength(0);
    expect(test.articleRows).toHaveLength(0);
  });

  it("rejects a queued request if an editor tampers with its signed keyword", async () => {
    const test = setup({ keywords: [readyKeyword()] });
    expect((await test.service.requestManualGeneration(request)).outcome).toBe("queued");
    test.keywordRows[0]!.primary_keyword = "tampered high-cost keyword";
    await test.service.runManualOnce();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.keywordRows[0]?.status).toBe("paused");
    expect(test.articleRows).toHaveLength(0);
  });

  it("rechecks locale settings after enqueue and before model execution", async () => {
    const liveSettings = settings();
    const test = setup({
      settings: liveSettings,
      keywords: [readyKeyword({ locale: "en" })],
    });
    const queued = await test.service.requestManualGeneration(request);
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
    await expect(test.service.requestManualGeneration({
      ...request,
      providerObjectId: "message:-5484259760:501",
    })).resolves.toMatchObject({
      outcome: "blocked",
      reason: "active_review_exists",
      articleId: regenerationRequest.articleId,
    });
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
    const test = setup({
      articles: [reviewArticle({ manual_required: false })],
      settings: settings({ generation_enabled: true }),
    });

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

  it("keeps a semantic manual gate sticky across an automatic repair", async () => {
    const test = setup({
      articles: [reviewArticle({ manual_required: true })],
      settings: settings({ generation_enabled: true }),
    });

    const result = await test.service.regenerateArticle({
      ...regenerationRequest,
      actorId: "auto-qa-repair",
      actorName: "Automatic QA repair",
      actorType: "system",
      provider: "system",
      providerObjectId: "sticky-repair",
    });

    expect(result).toMatchObject({ outcome: "regenerated" });
    expect(test.articleRows[0]).toMatchObject({
      status: "failed_qa",
      qa_status: "fail",
      manual_required: true,
    });
    expect(String(test.articleRows[0]?.qa_blockers)).toContain("manual_required");
  });

  it("rejects an automatic repair before spending when its expected draft hash is stale", async () => {
    const article = reviewArticle({ status: "failed_qa", manual_required: false });
    const expectedContentHash = articleContentHash(article);
    article.title = "Ručno izmenjen naslov pre automatskog pokušaja";
    const test = setup({ articles: [article] });

    const result = await test.service.regenerateArticle({
      ...regenerationRequest,
      actorId: "auto-qa-repair",
      actorName: "Automatic QA repair",
      actorType: "system",
      provider: "system",
      providerObjectId: "stale-before-paid",
      expectedContentHash,
      requireQaFailure: true,
    });

    expect(result).toMatchObject({ outcome: "blocked", reason: "stale_article" });
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
  });

  it("does not overwrite a Sheet edit made while a paid regeneration is running", async () => {
    const article = reviewArticle({ status: "failed_qa", manual_required: false });
    const oldBody = String(article.body_markdown);
    const expectedContentHash = articleContentHash(article);
    const test = setup({
      articles: [article],
      onGenerate: () => {
        article.body_markdown = "Ručna izmena nastala dok je model radio.";
      },
    });

    const result = await test.service.regenerateArticle({
      ...regenerationRequest,
      actorId: "auto-qa-repair",
      actorName: "Automatic QA repair",
      actorType: "system",
      provider: "system",
      providerObjectId: "stale-after-paid",
      expectedContentHash,
      requireQaFailure: true,
    });

    expect(result).toMatchObject({ outcome: "blocked", reason: "stale_article" });
    expect(test.generate).toHaveBeenCalledOnce();
    expect(article.body_markdown).not.toBe(oldBody);
    expect(article.body_markdown).toBe("Ručna izmena nastala dok je model radio.");
    expect(test.events.some((event) => event.event_type === "regenerated")).toBe(false);
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
    expect(test.events).toContainEqual(
      expect.objectContaining({ event_type: "regeneration_attempt_started" }),
    );
    expect(test.events.some((event) => event.event_type === "regenerated")).toBe(false);
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
      status: "failed_qa",
      qa_status: "fail",
      qa_blockers: "missing_authoritative_source",
      manual_required: true,
    });
  });
});
