import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { CellValue, SheetRecord } from "../src/domain/article.js";
import type { OpenAiArticleGenerator } from "../src/generation/openai-generator.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import {
  GenerationService,
  manualGenerationIsEnabled,
  manualRequestIds,
} from "../src/services/generation-service.js";

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
      body_markdown: "Dovoljno dugačak test tekst",
      tags: ["rs"],
      source_urls: ["https://example.com/source"],
      internal_links: ["https://example.com/rs"],
      quality_score: 9,
      qa_blockers: [],
    };
  });
  const store = {
    getSettings: async () => options.settings ?? settings(),
    listLinks: async () => [
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
    listEvents: async (articleId: string) => events.filter((event) => event.article_id === articleId),
    appendEvent: async (event: Record<string, CellValue>) => {
      events.push({ __rowNumber: events.length + 2, ...event });
    },
  };
  const service = new GenerationService(
    store as unknown as GoogleSheetsStore,
    { generate } as unknown as OpenAiArticleGenerator,
    config,
    logger,
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
    expect(test.articleRows[0]).toMatchObject({ article_id: ids.articleId, status: "needs_review" });
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
