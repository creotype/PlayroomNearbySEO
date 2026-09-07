import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { CellValue, SheetRecord } from "../src/domain/article.js";
import { articleContentHash } from "../src/domain/article.js";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { EditorialAutomationService } from "../src/services/editorial-automation-service.js";
import type { GenerationService } from "../src/services/generation-service.js";
import type { QualityGate } from "../src/services/quality-gate.js";
import type { SeoBot } from "../src/telegram/bot.js";

const mondayAfterTen = new Date("2026-09-07T08:01:00.000Z");

function keyword(overrides: Partial<SheetRecord> = {}): SheetRecord {
  return {
    __rowNumber: 2,
    keyword_id: "KW-1",
    article_id: "",
    locale: "sr",
    primary_keyword: "igraonice za decu Beograd",
    status: "ready",
    priority: 10,
    planned_publish_at: "",
    ...overrides,
  } as SheetRecord;
}

function review(overrides: Partial<SheetRecord> = {}): SheetRecord {
  const article = {
    __rowNumber: 8,
    article_id: "SEO-REVIEW-1",
    keyword_id: "KW-1",
    locale: "sr",
    status: "needs_review",
    primary_keyword: "igraonice za decu Beograd",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "Dovoljno dugačak tekst",
    excerpt: "Vodič",
    seo_title: "Kako izabrati igraonicu",
    meta_description: "Opis",
    tags: "rs",
    source_urls: "https://example.com/source",
    internal_links: "https://example.com/rs",
    feature_image_url: "https://example.com/image.jpg",
    feature_image_alt: "Igraonica",
    scheduled_publish_at: "",
    telegram_message_id: 100,
    updated_at: "2026-09-07T08:05:00.000Z",
    qa_status: "pass",
    qa_blockers: "",
    quality_score: 9,
    manual_required: false,
    ...overrides,
  } as SheetRecord;
  article.content_hash = articleContentHash(article);
  return article;
}

function setup(options: {
  now?: Date;
  keywords?: SheetRecord[];
  articles?: SheetRecord[];
  quality?: { passed: boolean; blockers: string[]; score: number };
  settings?: Record<string, CellValue>;
  deleteSettings?: string[];
  events?: SheetRecord[];
} = {}) {
  let now = options.now ?? mondayAfterTen;
  const keywords = options.keywords ?? [];
  const articles = options.articles ?? [];
  const events: SheetRecord[] = [...(options.events ?? [])];
  const settings = new Map<string, CellValue>([
    ["telegram_chat_id", -5484259760],
    ["generation_enabled", true],
    ["editorial_automation_enabled", true],
    ["editorial_run_days", "1,5"],
    ["editorial_run_time", "10:00"],
    ["auto_publish_after_review", true],
    ["review_deadline_hours", 48],
    ["publication_time", "10:00"],
    ["timezone", "Europe/Belgrade"],
    ...Object.entries(options.settings ?? {}),
  ]);
  for (const key of options.deleteSettings ?? []) settings.delete(key);
  const appendEvent = vi.fn(async (event: Record<string, CellValue>) => {
    if (!events.some((candidate) => candidate.event_id === event.event_id)) {
      events.push({ __rowNumber: events.length + 2, ...event });
    }
  });
  const store = {
    getSettings: async () => settings,
    listKeywords: async (statuses?: readonly string[]) =>
      keywords.filter((row) => !statuses || statuses.includes(String(row.status))),
    findKeyword: async (keywordId: string) => keywords.find((row) => row.keyword_id === keywordId),
    listArticles: async (statuses?: readonly string[]) =>
      articles.filter((row) => !statuses || statuses.includes(String(row.status))),
    findArticle: async (articleId: string) => articles.find((row) => row.article_id === articleId),
    listEvents: async (articleId: string) => events.filter((event) => event.article_id === articleId),
    appendEvent,
    patchArticleAndAppendEvent: async (
      articleId: string,
      patch: Record<string, CellValue>,
      event: Record<string, CellValue>,
    ) => {
      const article = articles.find((row) => row.article_id === articleId);
      if (!article) throw new Error(`Missing article ${articleId}`);
      Object.assign(article, patch);
      await appendEvent(event);
      return article;
    },
  } as unknown as GoogleSheetsStore;
  const runOnce = vi.fn(async (preferredKeywordId?: string) => {
    const eligible = keywords
      .filter((row) => ["ready", "assigned", "generating"].includes(String(row.status)))
      .sort((left, right) => Number(right.priority) - Number(left.priority) || left.__rowNumber - right.__rowNumber);
    const selected = preferredKeywordId
      ? eligible.find((row) => row.keyword_id === preferredKeywordId)
      : eligible[0];
    if (!selected) return;
    selected.status = "used";
    selected.article_id = "SEO-GENERATED-1";
    articles.push(review({
      __rowNumber: 10,
      article_id: "SEO-GENERATED-1",
      keyword_id: selected.keyword_id,
      telegram_message_id: "",
      updated_at: now.toISOString(),
    }));
  });
  const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: 321 }));
  const quality = options.quality ?? { passed: true, blockers: [], score: 9 };
  const service = new EditorialAutomationService(
    store,
    { runOnce } as unknown as GenerationService,
    { evaluate: vi.fn(async () => quality) } as unknown as QualityGate,
    { api: { sendMessage } } as unknown as SeoBot,
    {
      spreadsheetId: "sheet",
      telegramReviewChatId: -5484259760,
      editorialAutomationEnabled: true,
      editorialTimeZone: "Europe/Belgrade",
      editorialRunDays: [1, 5],
      editorialRunTime: "10:00",
      autoPublishAfterReview: true,
      reviewDeadlineHours: 48,
      publicationTime: "10:00",
    },
    { error: vi.fn() } as unknown as Logger,
    new KeyedMutex(),
    () => now,
  );
  return {
    service,
    keywords,
    articles,
    events,
    runOnce,
    sendMessage,
    appendEvent,
    setNow: (value: Date) => { now = value; },
  };
}

describe("EditorialAutomationService weekly queue", () => {
  it("warns once with the exact keyword Sheet link when a Monday slot has no source", async () => {
    const test = setup();
    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.runOnce).not.toHaveBeenCalled();
    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("Нет доступных тем");
    expect(text).toContain("status=ready");
    expect(text).toContain(
      "https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A2:T",
    );
    expect(test.events).toContainEqual(expect.objectContaining({
      article_id: "editorial-slot:2026-09-07T10:00@Europe/Belgrade",
      event_type: "editorial_slot_no_source_notified",
    }));
  });

  it("generates exactly one eligible keyword and durably completes the slot", async () => {
    const first = keyword({ keyword_id: "KW-FIRST", priority: 20 });
    const second = keyword({ __rowNumber: 3, keyword_id: "KW-SECOND", priority: 10 });
    const test = setup({ keywords: [first, second] });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.runOnce).toHaveBeenCalledTimes(1);
    expect(test.runOnce).toHaveBeenCalledWith("KW-FIRST");
    expect(first.status).toBe("used");
    expect(second.status).toBe("ready");
    expect(test.events).toContainEqual(expect.objectContaining({ event_type: "editorial_slot_generated" }));
  });

  it("keeps the slot pending while a prior review card is active", async () => {
    const article = review();
    const test = setup({ keywords: [keyword()], articles: [article] });

    await test.service.runOnce();

    expect(test.runOnce).not.toHaveBeenCalled();
    expect(test.events).toHaveLength(0);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it("reconciles a generated keyword after a crash before the slot marker and never claims the next row", async () => {
    const slotKey = "editorial-slot:2026-09-07T10:00@Europe/Belgrade";
    const completedKeyword = keyword({
      keyword_id: "KW-CRASHED",
      article_id: "SEO-CRASHED",
      status: "used",
    });
    const nextKeyword = keyword({ __rowNumber: 3, keyword_id: "KW-NEXT" });
    const generatedArticle = review({
      article_id: "SEO-CRASHED",
      keyword_id: "KW-CRASHED",
      status: "approved",
    });
    const test = setup({
      keywords: [completedKeyword, nextKeyword],
      articles: [generatedArticle],
      events: [{
        __rowNumber: 2,
        event_id: "evt-slot-started",
        article_id: slotKey,
        event_type: "editorial_slot_started",
        actor_type: "system",
        actor_id: "editorial-automation",
        provider: "system",
        payload_json: JSON.stringify({ keyword_id: "KW-CRASHED" }),
        created_at: "2026-09-07T08:00:00.000Z",
      } as SheetRecord],
    });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.runOnce).not.toHaveBeenCalled();
    expect(nextKeyword.status).toBe("ready");
    expect(test.events.filter((event) => event.event_type === "editorial_slot_generated")).toHaveLength(1);
  });
});

describe("EditorialAutomationService 48-hour review window", () => {
  it("auto-approves after 48 hours and schedules the first following 10:00 local", async () => {
    const article = review();
    const test = setup({
      now: new Date("2026-09-09T08:06:00.000Z"),
      articles: [article],
      settings: { generation_enabled: false },
    });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(article.status).toBe("approved");
    expect(article.approved_by).toBe("system:auto-review-timeout");
    expect(article.scheduled_publish_at).toBe("2026-09-10T08:00:00.000Z");
    expect(article.content_hash).toBe(articleContentHash(article));
    expect(test.events.filter((event) => event.event_type === "approved")).toHaveLength(1);
    const approval = test.events.find((event) => event.event_type === "approved");
    expect(approval).toMatchObject({ actor_id: "auto-review-timeout", provider: "system" });
    expect(JSON.parse(String(approval?.payload_json))).toMatchObject({ hash: article.content_hash });
    expect(test.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("schedules the next future 10:00 after a restart missed the original publication time", async () => {
    const article = review();
    const test = setup({
      // Review deadline was Wed 10:05 Belgrade; service comes back Fri 15:00.
      now: new Date("2026-09-11T13:00:00.000Z"),
      articles: [article],
      settings: { generation_enabled: false },
    });

    await test.service.runOnce();

    expect(article.status).toBe("approved");
    expect(article.scheduled_publish_at).toBe("2026-09-12T08:00:00.000Z");
    expect(new Date(String(article.scheduled_publish_at)).getTime()).toBeGreaterThan(
      new Date("2026-09-11T13:00:00.000Z").getTime(),
    );
  });

  it("does not approve before 48 hours and a regenerated card resets the timer", async () => {
    const article = review({ updated_at: "2026-09-09T07:30:00.000Z" });
    article.content_hash = articleContentHash(article);
    const test = setup({
      now: new Date("2026-09-09T08:06:00.000Z"),
      articles: [article],
      settings: { generation_enabled: false },
    });

    await test.service.runOnce();

    expect(article.status).toBe("needs_review");
    expect(test.events).toHaveLength(0);
  });

  it("keeps a failed-QA article in review and retries only its missing warning", async () => {
    const article = review();
    const test = setup({
      now: new Date("2026-09-09T08:06:00.000Z"),
      articles: [article],
      quality: { passed: false, blockers: ["missing_source_url"], score: 7 },
      settings: { generation_enabled: false },
    });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(article.status).toBe("needs_review");
    expect(article.qa_blockers).toBe("missing_source_url");
    expect(test.events.filter((event) => event.event_type === "auto_approval_blocked")).toHaveLength(1);
    expect(test.events.filter((event) => event.event_type === "auto_approval_blocked_notified")).toHaveLength(1);
    expect(test.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the existing review_window_hours and auto_publish_without_approval aliases", async () => {
    const article = review();
    const test = setup({
      now: new Date("2026-09-07T10:06:00.000Z"),
      articles: [article],
      settings: {
        generation_enabled: false,
        review_window_hours: 1,
        auto_publish_without_approval: true,
      },
      deleteSettings: ["review_deadline_hours", "auto_publish_after_review"],
    });

    await test.service.runOnce();

    expect(article.status).toBe("approved");
    expect(article.approved_by).toBe("system:auto-review-timeout");
  });
});
