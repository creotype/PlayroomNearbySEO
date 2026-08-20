import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { articleContentHash, type SheetRecord } from "../src/domain/article.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { ReviewNotifier } from "../src/services/review-notifier.js";
import type { SeoBot } from "../src/telegram/bot.js";

const config = {
  spreadsheetId: "sheet",
} as AppConfig;

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

describe("ReviewNotifier review cards", () => {
  it("sends a button-free card that teaches the two reply commands", async () => {
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
      listArticles: async () => [article],
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
    expect(text.toLowerCase()).toMatch(/ответ.*карточ/);
    expect(text.toLowerCase()).toContain("коммент");
    expect(options).not.toHaveProperty("reply_markup");
    expect(JSON.stringify(sendMessage.mock.calls[0])).not.toContain("callback_data");
    expect(patchArticle).toHaveBeenCalledWith(
      "SEO-TG-1",
      expect.objectContaining({ telegram_message_id: 123 }),
    );
  });

  it("replaces an existing legacy-button card with reply instructions exactly once", async () => {
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
      listArticles: async () => [article],
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
    expect(text.toLowerCase()).toMatch(/ответ.*карточ/);
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
      listArticles: async () => [article],
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
