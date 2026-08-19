import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { SheetRecord } from "../src/domain/article.js";
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
        event_id: "evt-failed",
        article_id: "SEO-TG-1",
        event_type: "generation_failed",
      },
    ];
    const keyword = {
      __rowNumber: 7,
      keyword_id: "KW-TG-1",
      article_id: "SEO-TG-1",
      primary_keyword: "igraonice Beograd",
      status: "paused",
      source: "telegram_manual:message:-1:1",
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
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("Генерация остановлена");
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.event_type === "generation_failure_notified")).toBe(true);
  });
});
