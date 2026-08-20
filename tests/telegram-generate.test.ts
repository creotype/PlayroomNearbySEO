import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Article } from "../src/domain/article.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import type { ApprovalService } from "../src/services/approval-service.js";
import type { GenerationService } from "../src/services/generation-service.js";
import {
  createTelegramBot,
  parseGenerateCommand,
  telegramCommandMenu,
} from "../src/telegram/bot.js";
import type { SeoBot } from "../src/telegram/bot.js";

describe("/generate command parser", () => {
  it("accepts the command with no arguments", () => {
    expect(parseGenerateCommand("")).toEqual({ outcome: "valid" });
    expect(parseGenerateCommand("   ")).toEqual({ outcome: "valid" });
  });

  it.each([
    "igraonice za decu Beograd",
    "--locale sr",
    "--locale en kids playrooms Belgrade",
    "sr",
  ])(
    "rejects every argument because the keyword must come from the Sheet queue: %j",
    (raw) => {
      expect(parseGenerateCommand(raw).outcome).toBe("invalid");
    },
  );

  it("exposes exactly the four owner-facing commands", () => {
    expect(telegramCommandMenu.map(({ command }) => command)).toEqual([
      "generate",
      "regenerate",
      "approve",
      "help",
    ]);
    expect(telegramCommandMenu).toHaveLength(4);
    expect(telegramCommandMenu.every(({ command }) => !command.startsWith("seo_"))).toBe(true);
  });
});

const config = {
  spreadsheetId: "sheet",
  telegramBotToken: "123456789:abcdefghijklmnopqrstuvwxyz",
  telegramReviewChatId: -5484259760,
  targetEnvironment: "staging",
} as AppConfig;

const queuedGenerationResult = {
  outcome: "queued" as const,
  keywordId: "KW-TG-1",
  articleId: "SEO-TG-1",
  locale: "sr",
  keyword: "igraonice za decu Beograd",
};

function botHarness(manualResult: Record<string, unknown> = queuedGenerationResult) {
  const requestManualGeneration = vi.fn(async () => manualResult);
  const article = {
    __rowNumber: 2,
    article_id: "SEO-TG-1",
    locale: "sr",
    status: "needs_review",
    title: "Igraonice za decu u Beogradu",
    slug: "igraonice-za-decu-u-beogradu",
    body_markdown: "draft",
    qa_status: "pass",
    qa_blockers: "",
    manual_required: false,
    revision_count: 1,
    telegram_message_id: 12,
  } as Article;
  const regenerateArticle = vi.fn(async () => ({
    outcome: "regenerated" as const,
    article,
  }));
  const approve = vi.fn(async () => ({
    outcome: "approved" as const,
    article: { ...article, status: "approved" },
  }));
  const findArticle = vi.fn(async (articleId: string) => articleId === article.article_id ? article : undefined);
  const findArticleByTelegramMessageId = vi.fn(
    async (messageId: number) => messageId === 12 ? article : undefined,
  );
  const store = {
    getSettings: async () => new Map(),
    findArticle,
    findArticleByTelegramMessageId,
  } as unknown as GoogleSheetsStore;
  const bot = createTelegramBot({
    config,
    store,
    approvals: { approve } as unknown as ApprovalService,
    generation: { requestManualGeneration, regenerateArticle } as unknown as GenerationService,
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
  return {
    bot,
    requestManualGeneration,
    regenerateArticle,
    approve,
    findArticle,
    findArticleByTelegramMessageId,
    article,
    apiCalls,
  };
}

function sentMessagePayload(test: ReturnType<typeof botHarness>) {
  return test.apiCalls.find((call) => call.method === "sendMessage")?.payload as
    | { text?: string; parse_mode?: string; link_preview_options?: { is_disabled?: boolean } }
    | undefined;
}

function generateUpdate(
  chatId: number,
  chatType: "private" | "supergroup" = "supergroup",
  args = "",
) {
  const text = `/generate${args ? ` ${args}` : ""}`;
  return {
    update_id: 1,
    message: {
      message_id: 77,
      date: 1,
      chat: chatType === "private"
        ? { id: chatId, type: "private" as const, first_name: "Owner" }
        : { id: chatId, type: "supergroup" as const, title: "Review" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text,
      entities: [{ offset: 0, length: 9, type: "bot_command" as const }],
    },
  };
}

describe("/generate Telegram handler", () => {
  it("queues a request only from the configured review group", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(generateUpdate(-5484259760));
    expect(test.requestManualGeneration).toHaveBeenCalledWith({
      actorId: 42,
      actorName: "Owner",
      providerObjectId: "message:-5484259760:77",
    });
    expect(test.apiCalls.some((call) => call.method === "sendMessage")).toBe(true);
  });

  it("shows every invalid field and a deep link to the exact keyword row", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "invalid_keyword_row",
      rowNumber: 7,
      locale: "sr",
      invalidFields: ["keyword_id", "primary_keyword", "article_id"],
      articleId: "SEO-LEFTOVER",
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("строке 7");
    expect(payload?.text).toContain("keyword_id");
    expect(payload?.text).toContain("primary_keyword");
    expect(payload?.text).toContain("article_id");
    expect(payload?.text).toContain("SEO-LEFTOVER");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A7:T7"',
    );
  });

  it("shows every conflicting row when keyword_id is duplicated", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "duplicate_keyword_id",
      keywordId: "KW-<DUPLICATE>&",
      rowNumber: 4,
      conflictingRows: [4, 9],
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("KW-&lt;DUPLICATE&gt;&amp;");
    expect(payload?.text).not.toContain("KW-<DUPLICATE>&");
    expect(payload?.text).toContain("keyword_id");
    expect(payload?.text).toContain("4, 9");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A4:T4"',
    );
  });

  it("explains a concurrent Sheet edit without claiming or overwriting it", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "keyword_row_changed",
      keywordId: "KW-EDIT-RACE",
      rowNumber: 12,
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("ничего не перезаписал");
    expect(payload?.text).toContain("status=ready");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A12:T12"',
    );
  });

  it("links to the keywords tab when there are no ready rows without rendering an undefined range", async () => {
    const test = botHarness({ outcome: "blocked", reason: "no_ready_keywords" });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("ready");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002',
    );
    expect(payload?.text).not.toContain("undefined");
  });

  it("explains a disabled locale and links to its exact keyword row", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "locale_disabled",
      keywordId: "KW-DE-OFF",
      rowNumber: 8,
      locale: "de",
      allowedLocales: ["sr", "en"],
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("DE");
    expect(payload?.text).toContain("SR");
    expect(payload?.text).toContain("EN");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A8:T8"',
    );
  });

  it("points to link_inventory and the exact keyword row when internal links are missing", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "no_internal_links",
      keywordId: "KW-NO-LINKS",
      rowNumber: 12,
      locale: "en",
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("EN");
    expect(payload?.text).toContain("link_inventory");
    expect(payload?.text).toContain("environment=staging");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A12:T12"',
    );
  });

  it("shows the queue occupancy and waiting keyword row when the manual queue is full", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "queue_full",
      keywordId: "KW-WAITING",
      rowNumber: 15,
      queueLimit: 3,
      activeCount: 3,
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toMatch(/3(?:\/| из )3/);
    expect(payload?.text).toContain("KW-WAITING");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000002&range=A15:T15"',
    );
  });

  it("rejects command arguments without claiming a queued keyword", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(generateUpdate(-5484259760, "supergroup", "custom keyword"));
    expect(test.requestManualGeneration).not.toHaveBeenCalled();
    const reply = test.apiCalls.find((call) => call.method === "sendMessage");
    expect(JSON.stringify(reply?.payload)).toContain("/generate");
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

function commandUpdate(
  command: string,
  args = "",
  options: { replyMessageId?: number; messageId?: number; updateId?: number } = {},
): Parameters<SeoBot["handleUpdate"]>[0] {
  const text = `/${command}${args ? ` ${args}` : ""}`;
  const replyToMessage = options.replyMessageId
    ? {
        message_id: options.replyMessageId,
        date: 1,
        chat: { id: -5484259760, type: "supergroup" as const, title: "Review" },
        from: { id: 8692086487, is_bot: true, first_name: "Playroom Nearby" },
        text: "SEO draft",
      }
    : undefined;
  return {
    update_id: options.updateId ?? 2,
    message: {
      message_id: options.messageId ?? 78,
      date: 1,
      chat: { id: -5484259760, type: "supergroup" as const, title: "Review" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text,
      entities: [{ offset: 0, length: command.length + 1, type: "bot_command" as const }],
      ...(replyToMessage ? { reply_to_message: replyToMessage } : {}),
    },
  } as unknown as Parameters<SeoBot["handleUpdate"]>[0];
}

function legacyCallbackUpdate(action: "approve" | "regenerate" | "status") {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "review",
      from: { id: 42, is_bot: false, first_name: "Owner" },
      data: `seo:${action}:SEO-TG-1`,
      message: {
        message_id: 12,
        date: 1,
        chat: { id: -5484259760, type: "supergroup" as const, title: "Review" },
        text: "SEO draft",
      },
    },
  };
}

describe("minimal Telegram review workflow", () => {
  it("/help documents only generation, reply-with-comment regeneration, and reply approval", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("help"));

    const help = String(sentMessagePayload(test)?.text ?? "");
    expect(help).toContain("/generate");
    expect(help).toContain("/regenerate");
    expect(help).toContain("/approve");
    expect(help.toLowerCase()).toMatch(/ответ.*карточ/);
    expect(help.toLowerCase()).toContain("коммент");
    expect(help).not.toContain("/seo_");
    expect(help).not.toContain("/status");
    expect(help).not.toContain("/cancel");
    expect(help).not.toContain("ARTICLE-ID");
  });

  it("regenerates the replied-to article with a required editor comment", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("regenerate", "  ispravi izvore i proveri činjenice  ", {
      replyMessageId: 12,
    }));

    expect(test.regenerateArticle).toHaveBeenCalledWith({
      articleId: "SEO-TG-1",
      feedback: "ispravi izvore i proveri činjenice",
      actorId: 42,
      actorName: "Owner",
      providerObjectId: "message:-5484259760:78",
    });
    expect(test.findArticleByTelegramMessageId).toHaveBeenCalledWith(12);
    expect(test.findArticle).not.toHaveBeenCalled();
  });

  it("rejects /regenerate without a nonblank comment", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("regenerate", "   ", { replyMessageId: 12 }));

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.findArticleByTelegramMessageId).not.toHaveBeenCalled();
    expect(String(sentMessagePayload(test)?.text ?? "").toLowerCase()).toContain("коммент");
  });

  it("rejects /regenerate with a comment unless it replies to a review card", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("regenerate", "SEO-TG-1 ispravi izvore"));

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.findArticle).not.toHaveBeenCalled();
    expect(String(sentMessagePayload(test)?.text ?? "").toLowerCase()).toMatch(/ответ.*карточ/);
  });

  it("approves only the article whose card receives a bare /approve reply", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("approve", "", { replyMessageId: 12 }));

    expect(test.approve).toHaveBeenCalledWith("SEO-TG-1", {
      id: 42,
      displayName: "Owner",
      providerObjectId: "message:-5484259760:78",
    });
    expect(test.findArticleByTelegramMessageId).toHaveBeenCalledWith(12);
    expect(test.findArticle).not.toHaveBeenCalled();
  });

  it.each([
    ["without a reply", commandUpdate("approve")],
    ["with arguments", commandUpdate("approve", "SEO-TG-1", { replyMessageId: 12 })],
  ])("rejects /approve %s", async (_case, update) => {
    const test = botHarness();
    await test.bot.handleUpdate(update);

    expect(test.approve).not.toHaveBeenCalled();
    expect(String(sentMessagePayload(test)?.text ?? "")).toContain("/approve");
  });

  it.each([
    "seo_help",
    "seo_chat_id",
    "seo_status",
    "seo_cancel",
    "seo_regenerate",
    "seo_approve",
  ])("does not execute the removed /%s workflow", async (legacyCommand) => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate(legacyCommand));

    expect(test.requestManualGeneration).not.toHaveBeenCalled();
    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.approve).not.toHaveBeenCalled();
    expect(test.findArticle).not.toHaveBeenCalled();
    expect(test.findArticleByTelegramMessageId).not.toHaveBeenCalled();
    expect(test.apiCalls).toHaveLength(0);
  });

  it.each(["approve", "regenerate", "status"] as const)(
    "ignores the removed %s inline callback",
    async (action) => {
      const test = botHarness();
      await test.bot.handleUpdate(legacyCallbackUpdate(action));

      expect(test.regenerateArticle).not.toHaveBeenCalled();
      expect(test.approve).not.toHaveBeenCalled();
      expect(test.findArticle).not.toHaveBeenCalled();
      expect(test.apiCalls).toHaveLength(0);
    },
  );
});
