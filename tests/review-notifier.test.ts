import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { articleContentHash, type SheetRecord } from "../src/domain/article.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { ReviewNotifier } from "../src/services/review-notifier.js";
import type { SeoBot } from "../src/telegram/bot.js";

const config = {
  spreadsheetId: "sheet",
  targetEnvironment: "staging",
} as AppConfig;

const canonicalPublicUrl = "https://beaver.run.place/sr/blog/kako-izabrati-igraonicu";

function publicationArticle(overrides: Partial<SheetRecord> = {}): SheetRecord {
  return {
    __rowNumber: 14,
    article_id: "SEO-PUBLISH-1",
    locale: "sr",
    status: "published",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "draft",
    public_url: canonicalPublicUrl,
    ghost_draft_url: "https://beaver.run.place/internal/ghost-post",
    last_error: "",
    ...overrides,
  } as SheetRecord;
}

function publicationEvent(
  eventType: "published" | "publish_failed",
  overrides: Partial<SheetRecord> = {},
): SheetRecord {
  return {
    __rowNumber: 20,
    event_id: `evt-${eventType}-1`,
    article_id: "SEO-PUBLISH-1",
    event_type: eventType,
    from_status: "publishing",
    to_status: eventType === "published" ? "published" : "failed_publish",
    actor_type: "system",
    actor_id: "publisher",
    provider: "ghost",
    provider_object_id: "",
    message: eventType === "published" ? "Published to Ghost" : "Ghost request returned 503",
    payload_json: eventType === "published"
      ? JSON.stringify({
          public_url: canonicalPublicUrl,
          verification: { ok: true, status: 200, message: "Public page verified" },
        })
      : "",
    created_at: "2026-08-20T12:00:00.000Z",
    ...overrides,
  } as SheetRecord;
}

function telegramApprovalEvent(overrides: Partial<SheetRecord> = {}): SheetRecord {
  return {
    __rowNumber: 19,
    event_id: "evt-approved-telegram",
    article_id: "SEO-PUBLISH-1",
    event_type: "approved",
    from_status: "needs_review",
    to_status: "approved",
    actor_type: "telegram_user",
    actor_id: "42",
    provider: "telegram",
    provider_object_id: "message:-5484259760:78",
    message: "Approved by Owner",
    payload_json: JSON.stringify({ hash: "approved-content-hash" }),
    created_at: "2026-08-20T11:59:00.000Z",
    ...overrides,
  } as SheetRecord;
}

function publicationNotifierHarness(options: {
  article?: SheetRecord;
  events?: SheetRecord[];
  sendMessage?: ReturnType<typeof vi.fn>;
  publicPageVerifier?: (url: string) => Promise<{
    ok: boolean;
    status?: number;
    message: string;
  }>;
}) {
  const article = options.article ?? publicationArticle();
  const events = [...(options.events ?? [telegramApprovalEvent(), publicationEvent("published")])];
  const appendEvent = vi.fn(async (event: Record<string, unknown>) => {
    events.push({ __rowNumber: events.length + 30, ...event } as SheetRecord);
  });
  const listArticles = vi.fn(async (statuses?: readonly string[]) =>
    statuses?.includes(String(article.status)) ? [article] : [],
  );
  const listEvents = vi.fn(async (articleId: string) =>
    events.filter((event) => event.article_id === articleId),
  );
  const sendMessage = options.sendMessage ?? vi.fn(async (..._args: unknown[]) => ({ message_id: 321 }));
  const store = {
    getSettings: async () => new Map<string, string | number>([
      ["telegram_chat_id", -5484259760],
      ["staging_frontend_base_url", "https://beaver.run.place"],
    ]),
    listArticles,
    listKeywords: async () => [],
    listEvents,
    appendEvent,
  } as unknown as GoogleSheetsStore;
  const bot = { api: { sendMessage } } as unknown as SeoBot;
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const publicPageVerifier = options.publicPageVerifier ?? vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    message: "Live public page verified",
  }));
  return {
    notifier: new ReviewNotifier(store, bot, config, logger, publicPageVerifier),
    article,
    events,
    appendEvent,
    listArticles,
    listEvents,
    sendMessage,
    logger,
    publicPageVerifier,
  };
}

describe("ReviewNotifier generation failures", () => {
  it("notifies the review group once when a manual generation fails", async () => {
    const events: SheetRecord[] = [
      {
        __rowNumber: 2,
        event_id: "evt-requested",
        article_id: "SEO-TG-1",
        event_type: "generation_requested",
        actor_type: "telegram_user",
        actor_id: "42",
        provider: "telegram",
        provider_object_id: "message:-1:1",
        payload_json: JSON.stringify({
          request_kind: "sheet_queue",
          keyword_id: "KW-TG-1",
          article_id: "SEO-TG-1",
          row_number: 7,
          locale: "sr",
          keyword: "igraonice Beograd",
          signature: "a".repeat(64),
        }),
      },
      {
        __rowNumber: 3,
        event_id: "evt-failed",
        article_id: "SEO-TG-1",
        event_type: "generation_blocked",
        payload_json: JSON.stringify({ keyword_id: "KW-TG-1", reason: "no_internal_links" }),
      },
    ];
    const keyword = {
      __rowNumber: 7,
      keyword_id: "KW-TG-1",
      article_id: "SEO-TG-1",
      primary_keyword: "igraonice Beograd",
      status: "paused",
      source: "seo_research_import",
    } as SheetRecord;
    const appendEvent = vi.fn(async (event: Record<string, unknown>) => {
      events.push({ __rowNumber: events.length + 2, ...event } as SheetRecord);
    });
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: 123 }));
    const store = {
      getSettings: async () => new Map([["telegram_chat_id", -5484259760]]),
      listArticles: async () => [],
      listKeywords: async () => [keyword],
      listEvents: async () => events,
      appendEvent,
    } as unknown as GoogleSheetsStore;
    const bot = { api: { sendMessage } } as unknown as SeoBot;
    const logger = { error: vi.fn() } as unknown as Logger;
    const notifier = new ReviewNotifier(store, bot, config, logger);

    await notifier.runOnce();
    await notifier.runOnce();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const notification = String(sendMessage.mock.calls[0]?.[1]);
    expect(notification).toContain("Генерация остановлена");
    expect(notification).toContain("link_inventory");
    expect(notification).toContain("очистите article_id");
    expect(notification).toContain("status=ready");
    expect(notification).toContain("/generate");
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.event_type === "generation_failure_notified")).toBe(true);
  });
});

describe("ReviewNotifier publication outcomes", () => {
  it("notifies a published article exactly once with a clickable public URL and audit marker", async () => {
    const published = publicationEvent("published", { event_id: "evt-published-success" });
    const test = publicationNotifierHarness({ events: [telegramApprovalEvent(), published] });

    await test.notifier.runOnce();
    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    expect(test.sendMessage.mock.calls[0]?.[0]).toBe(-5484259760);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    const messageOptions = test.sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(text).toContain("SEO-PUBLISH-1");
    expect(text).toContain("✅");
    expect(text.toLowerCase()).toContain("опублик");
    expect(text).toContain(
      '<a href="https://beaver.run.place/sr/blog/kako-izabrati-igraonicu"',
    );
    expect(text).not.toContain("https://beaver.run.place/internal/ghost-post");
    expect(messageOptions?.parse_mode).toBe("HTML");
    expect(test.publicPageVerifier).toHaveBeenCalledTimes(1);
    expect(test.publicPageVerifier).toHaveBeenCalledWith(canonicalPublicUrl);
    expect(test.appendEvent).toHaveBeenCalledTimes(1);
    const marker = test.appendEvent.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(marker?.event_type).toBe("publication_notified");
    expect(marker?.article_id).toBe("SEO-PUBLISH-1");
    expect(String(marker?.provider_object_id)).toBe("321");
    expect(String(marker?.payload_json)).toContain("evt-published-success");
  });

  it("warns instead of sending a green success when the recorded success URL is now live-404", async () => {
    const publicPageVerifier = vi.fn(async (url: string) => ({
      ok: false,
      status: 404,
      message: `Live public URL returned 404: ${url}`,
    }));
    const published = publicationEvent("published", {
      event_id: "evt-published-live-404",
    });
    const test = publicationNotifierHarness({
      events: [telegramApprovalEvent(), published],
      publicPageVerifier,
    });

    await test.notifier.runOnce();

    expect(publicPageVerifier).toHaveBeenCalledTimes(1);
    expect(publicPageVerifier).toHaveBeenCalledWith(canonicalPublicUrl);
    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("⚠️");
    expect(text).toContain("404");
    expect(text).not.toContain("✅");
    expect(text.toLowerCase()).not.toContain("опубликована в ghost");
    expect(text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A14:AO14"',
    );
    expect(test.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("retries a failed Telegram send and creates no notification marker before delivery succeeds", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Telegram unavailable"))
      .mockResolvedValueOnce({ message_id: 322 });
    const test = publicationNotifierHarness({
      events: [
        telegramApprovalEvent(),
        publicationEvent("published", { event_id: "evt-published-retry" }),
      ],
      sendMessage,
    });

    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    expect(test.appendEvent).not.toHaveBeenCalled();
    expect(test.events.some((event) => event.event_type === "publication_notified")).toBe(false);
    expect(test.logger.error).toHaveBeenCalled();

    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(2);
    expect(test.appendEvent).toHaveBeenCalledTimes(1);
    expect(test.events.filter((event) => event.event_type === "publication_notified")).toHaveLength(1);
  });

  it("warns instead of claiming success when public-page verification failed", async () => {
    const published = publicationEvent("published", {
      event_id: "evt-published-unverified",
      payload_json: JSON.stringify({
        public_url: canonicalPublicUrl,
        verification: { ok: false, status: 404, message: "Public URL returned 404" },
      }),
    });
    const test = publicationNotifierHarness({
      events: [telegramApprovalEvent(), published],
    });

    await test.notifier.runOnce();
    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("⚠️");
    expect(text).toContain("404");
    expect(text).not.toContain("✅");
    expect(text.toLowerCase()).not.toContain("опубликована в ghost");
    expect(text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A14:AO14"',
    );
    expect(test.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("warns instead of claiming success when the published event lacks verified URL evidence", async () => {
    const published = publicationEvent("published", {
      event_id: "evt-published-missing-evidence",
      payload_json: "",
    });
    const test = publicationNotifierHarness({
      events: [telegramApprovalEvent(), published],
    });

    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("⚠️");
    expect(text).not.toContain("✅");
    expect(text.toLowerCase()).not.toContain("опубликована в ghost");
    expect(text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A14:AO14"',
    );
  });

  it.each([
    {
      name: "event URL differs from the canonical Article URL",
      articleUrl: canonicalPublicUrl,
      eventUrl: "https://beaver.run.place/sr/blog/drugi-slug",
    },
    {
      name: "the recorded URL uses an unexpected host",
      articleUrl: "https://unexpected.example/sr/blog/kako-izabrati-igraonicu",
      eventUrl: "https://unexpected.example/sr/blog/kako-izabrati-igraonicu",
    },
  ])("warns without a success claim when $name", async ({ articleUrl, eventUrl }) => {
    const article = publicationArticle({ public_url: articleUrl });
    const published = publicationEvent("published", {
      event_id: `evt-published-unsafe-${new URL(eventUrl).hostname}`,
      payload_json: JSON.stringify({
        public_url: eventUrl,
        verification: { ok: true, status: 200, message: "Public page verified" },
      }),
    });
    const test = publicationNotifierHarness({
      article,
      events: [telegramApprovalEvent(), published],
    });

    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("⚠️");
    expect(text).not.toContain("✅");
    expect(text.toLowerCase()).not.toContain("опубликована в ghost");
    expect(text).not.toContain(`href="${eventUrl}"`);
    expect(text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A14:AO14"',
    );
  });

  it("notifies an actionable publication failure with its reason and exact Article Sheet row once", async () => {
    const failed = publicationArticle({
      status: "failed_publish",
      public_url: "",
      last_error: "Ghost request returned 503 <retry>",
    });
    const failure = publicationEvent("publish_failed", {
      event_id: "evt-publish-failed-actionable",
      message: "Ghost request returned 503 <retry>",
    });
    const test = publicationNotifierHarness({
      article: failed,
      events: [telegramApprovalEvent(), failure],
    });

    await test.notifier.runOnce();
    await test.notifier.runOnce();

    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    const text = String(test.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("SEO-PUBLISH-1");
    expect(text).toContain("503");
    expect(text).not.toContain("<retry>");
    expect(text).toContain("&lt;retry&gt;");
    expect(text.toLowerCase()).toMatch(/исправ|повтор|админист/);
    expect(text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A14:AO14"',
    );
    expect(test.appendEvent).toHaveBeenCalledTimes(1);
    expect((test.appendEvent.mock.calls[0]?.[0] as Record<string, unknown>)?.event_type)
      .toBe("publication_notified");
  });

  it("skips a historical publication outcome that already has a notification marker", async () => {
    const published = publicationEvent("published", { event_id: "evt-published-historical" });
    const marker = publicationEvent("published", {
      __rowNumber: 21,
      event_id: "evt-publication-notified-evt-published-historical",
      event_type: "publication_notified",
      actor_id: "review-notifier",
      provider: "telegram",
      provider_object_id: "320",
      message: "Publication notification sent",
      payload_json: JSON.stringify({ publication_event_id: "evt-published-historical" }),
    } as Partial<SheetRecord>);
    const test = publicationNotifierHarness({
      events: [telegramApprovalEvent(), published, marker],
    });

    await test.notifier.runOnce();

    expect(test.sendMessage).not.toHaveBeenCalled();
    expect(test.appendEvent).not.toHaveBeenCalled();
  });

  it("skips a publication outcome that has no Telegram approval event", async () => {
    const nonTelegramApproval = telegramApprovalEvent({
      event_id: "evt-approved-system",
      actor_type: "system",
      actor_id: "migration",
      provider: "system",
      provider_object_id: "",
    });
    const published = publicationEvent("published", { event_id: "evt-published-without-owner" });
    const test = publicationNotifierHarness({
      events: [nonTelegramApproval, published],
    });

    await test.notifier.runOnce();

    expect(test.sendMessage).not.toHaveBeenCalled();
    expect(test.appendEvent).not.toHaveBeenCalled();
  });
});

describe("ReviewNotifier review cards", () => {
  it("sends a button-free card that teaches the two current-article commands", async () => {
    const article = {
      __rowNumber: 2,
      article_id: "SEO-TG-1",
      primary_keyword: "igraonice za decu Beograd",
      locale: "sr",
      status: "needs_review",
      title: "Igraonice za decu u Beogradu",
      slug: "igraonice-za-decu-u-beogradu",
      body_markdown: "draft",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      quality_score: 9,
      telegram_message_id: "",
      content_hash: "",
    } as SheetRecord;
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: 123 }));
    const patchArticle = vi.fn(async () => article);
    const store = {
      getSettings: async () => new Map([["telegram_chat_id", -5484259760]]),
      listArticles: async (statuses?: readonly string[]) =>
        statuses?.includes("needs_review") ? [article] : [],
      listKeywords: async () => [],
      patchArticle,
    } as unknown as GoogleSheetsStore;
    const bot = { api: { sendMessage } } as unknown as SeoBot;
    const notifier = new ReviewNotifier(
      store,
      bot,
      config,
      { error: vi.fn() } as unknown as Logger,
    );

    await notifier.runOnce();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
    const options = sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(text).toContain("/regenerate");
    expect(text).toContain("/approve");
    expect(text).toContain("/approve — согласовать эту статью");
    expect(text.toLowerCase()).toContain("коммент");
    expect(options).not.toHaveProperty("reply_markup");
    expect(JSON.stringify(sendMessage.mock.calls[0])).not.toContain("callback_data");
    expect(patchArticle).toHaveBeenCalledWith(
      "SEO-TG-1",
      expect.objectContaining({ telegram_message_id: 123 }),
    );
  });

  it("replaces an existing legacy-button card with button-free instructions exactly once", async () => {
    const article = {
      __rowNumber: 2,
      article_id: "SEO-TG-1",
      primary_keyword: "igraonice za decu Beograd",
      locale: "sr",
      status: "needs_review",
      title: "Igraonice za decu u Beogradu",
      slug: "igraonice-za-decu-u-beogradu",
      body_markdown: "draft",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      quality_score: 9,
      telegram_message_id: 12,
    } as SheetRecord;
    article.content_hash = articleContentHash(article);
    const editMessageText = vi.fn(async (..._args: unknown[]) => true);
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: 123 }));
    const store = {
      getSettings: async () => new Map([["telegram_chat_id", -5484259760]]),
      listArticles: async (statuses?: readonly string[]) =>
        statuses?.includes("needs_review") ? [article] : [],
      listKeywords: async () => [],
      patchArticle: vi.fn(async () => article),
    } as unknown as GoogleSheetsStore;
    const bot = { api: { editMessageText, sendMessage } } as unknown as SeoBot;
    const notifier = new ReviewNotifier(
      store,
      bot,
      config,
      { error: vi.fn() } as unknown as Logger,
    );

    await notifier.runOnce();
    await notifier.runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledTimes(1);
    const text = String(editMessageText.mock.calls[0]?.[2] ?? "");
    const options = editMessageText.mock.calls[0]?.[3] as
      | { reply_markup?: { inline_keyboard?: unknown[][] } }
      | undefined;
    expect(text).toContain("/regenerate");
    expect(text).toContain("/approve");
    expect(text).toContain("/approve — согласовать эту статью");
    expect(options?.reply_markup?.inline_keyboard ?? []).toHaveLength(0);
    expect(JSON.stringify(editMessageText.mock.calls[0])).not.toContain("callback_data");
  });

  it("clears a stale Telegram message mapping so the next poll can send a replacement card", async () => {
    const article = {
      __rowNumber: 2,
      article_id: "SEO-TG-STALE",
      primary_keyword: "igraonice za decu Beograd",
      locale: "sr",
      status: "needs_review",
      title: "Igraonice za decu u Beogradu",
      slug: "igraonice-za-decu-u-beogradu",
      body_markdown: "draft",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      quality_score: 9,
      telegram_message_id: 12,
      content_hash: "old-hash",
    } as SheetRecord;
    const patchArticle = vi.fn(async () => article);
    const editMessageText = vi.fn(async () => {
      throw new Error("Call to 'editMessageText' failed! (400: Bad Request: message to edit not found)");
    });
    const store = {
      getSettings: async () => new Map([["telegram_chat_id", -5484259760]]),
      listArticles: async (statuses?: readonly string[]) =>
        statuses?.includes("needs_review") ? [article] : [],
      listKeywords: async () => [],
      patchArticle,
    } as unknown as GoogleSheetsStore;
    const bot = { api: { editMessageText } } as unknown as SeoBot;
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const notifier = new ReviewNotifier(store, bot, config, logger);

    await notifier.runOnce();

    expect(patchArticle).toHaveBeenCalledWith(
      "SEO-TG-STALE",
      expect.objectContaining({ telegram_message_id: "", content_hash: "" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
