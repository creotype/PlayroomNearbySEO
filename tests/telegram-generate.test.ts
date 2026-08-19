import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import type { ApprovalService } from "../src/services/approval-service.js";
import type { GenerationService } from "../src/services/generation-service.js";
import { createTelegramBot, parseGenerateCommand, telegramCommandMenu } from "../src/telegram/bot.js";

describe("/generate command parser", () => {
  it("uses the Sheet default locale when no locale is supplied", () => {
    expect(parseGenerateCommand("  igraonice   za decu Beograd ")).toEqual({
      outcome: "valid",
      keyword: "igraonice za decu Beograd",
    });
  });

  it.each([
    ["--locale en kids playrooms Belgrade", "en", "kids playrooms Belgrade"],
    ["--locale=en kids playrooms Belgrade", "en", "kids playrooms Belgrade"],
  ])("parses an explicit locale from %s", (raw, locale, keyword) => {
    expect(parseGenerateCommand(raw)).toEqual({ outcome: "valid", locale, keyword });
  });

  it.each(["", "   ", "--locale sr", "--unknown value", "x", "sr", "en", "ru"])(
    "rejects an incomplete request: %j",
    (raw) => {
      expect(parseGenerateCommand(raw).outcome).toBe("invalid");
    },
  );

  it("does not treat a keyword starting with a locale token as an implicit option", () => {
    expect(parseGenerateCommand("en kids club Belgrade")).toEqual({
      outcome: "valid",
      keyword: "en kids club Belgrade",
    });
  });

  it("registers generate in the Telegram command menu", () => {
    expect(telegramCommandMenu.some((command) => command.command === "generate")).toBe(true);
  });
});

const config = {
  telegramBotToken: "123456789:abcdefghijklmnopqrstuvwxyz",
  telegramReviewChatId: -5484259760,
} as AppConfig;

function botHarness() {
  const requestManualGeneration = vi.fn(async () => ({
    outcome: "queued" as const,
    keywordId: "KW-TG-1",
    articleId: "SEO-TG-1",
    locale: "sr",
    keyword: "igraonice za decu Beograd",
  }));
  const store = { getSettings: async () => new Map() } as unknown as GoogleSheetsStore;
  const bot = createTelegramBot({
    config,
    store,
    approvals: {} as ApprovalService,
    generation: { requestManualGeneration } as unknown as GenerationService,
    logger: { error: vi.fn() } as unknown as Logger,
  });
  bot.botInfo = {
    id: 8692086487,
    is_bot: true,
    first_name: "Playroom Nearby",
    username: "playroom_nearby_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const apiCalls: Array<{ method: string; payload: unknown }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload });
    return {
      ok: true,
      result: method === "sendMessage"
        ? {
            message_id: apiCalls.length,
            date: 1,
            chat: { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "supergroup", title: "Review" },
          }
        : true,
    } as never;
  });
  return { bot, requestManualGeneration, apiCalls };
}

function generateUpdate(chatId: number, chatType: "private" | "supergroup" = "supergroup") {
  return {
    update_id: 1,
    message: {
      message_id: 77,
      date: 1,
      chat: chatType === "private"
        ? { id: chatId, type: "private" as const, first_name: "Owner" }
        : { id: chatId, type: "supergroup" as const, title: "Review" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "/generate igraonice za decu Beograd",
      entities: [{ offset: 0, length: 9, type: "bot_command" as const }],
    },
  };
}

describe("/generate Telegram handler", () => {
  it("queues a request only from the configured review group", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(generateUpdate(-5484259760));
    expect(test.requestManualGeneration).toHaveBeenCalledWith({
      keyword: "igraonice za decu Beograd",
      actorId: 42,
      actorName: "Owner",
      providerObjectId: "message:-5484259760:77",
    });
    expect(test.apiCalls.some((call) => call.method === "sendMessage")).toBe(true);
  });

  it.each([
    ["private chat", generateUpdate(42, "private")],
    ["another group", generateUpdate(-999)],
  ])("rejects %s without touching the generation queue", async (_name, update) => {
    const test = botHarness();
    await test.bot.handleUpdate(update);
    expect(test.requestManualGeneration).not.toHaveBeenCalled();
    expect(test.apiCalls.some((call) => call.method === "sendMessage")).toBe(true);
  });
});
