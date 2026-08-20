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

function reviewArticle(overrides: Partial<Article> = {}): Article {
  return {
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
    ...overrides,
  } as Article;
}

function botHarness(
  manualResult: Record<string, unknown> = queuedGenerationResult,
  options: { reviewArticles?: Article[]; failSendMessageCalls?: number[] } = {},
) {
  const requestManualGeneration = vi.fn(async () => manualResult);
  const article = reviewArticle();
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
    async (messageId: number) => (options.reviewArticles ?? [article]).find(
      (candidate) => Number(candidate.telegram_message_id) === messageId,
    ),
  );
  const listArticles = vi.fn(async () => options.reviewArticles ?? [article]);
  const store = {
    getSettings: async () => new Map(),
    listArticles,
    findArticle,
    findArticleByTelegramMessageId,
  } as unknown as GoogleSheetsStore;
  const bot = createTelegramBot({
    config,
    store,
    approvals: { approve } as unknown as ApprovalService,
    generation: { requestManualGeneration, regenerateArticle } as unknown as GenerationService,
    logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
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
    const sendMessageCall = apiCalls.filter((call) => call.method === "sendMessage").length;
    if (method === "sendMessage" && options.failSendMessageCalls?.includes(sendMessageCall)) {
      throw new Error(`sendMessage ${sendMessageCall} failed`);
    }
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
    listArticles,
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

  it("explains that /generate is blocked until the sole active review article is resolved", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "active_review_exists",
      articleId: "SEO-TG-ACTIVE",
      rowNumber: 22,
      telegramMessageId: 75,
      activeCount: 1,
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("SEO-TG-ACTIVE");
    expect(payload?.text?.toLowerCase()).toMatch(/соглас|ревью|активн/);
    expect(payload?.text).toContain("/regenerate");
    expect(payload?.text).toContain("/approve");
    expect(payload?.text).toContain(
      'href="https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&range=A22:AO22"',
    );
    expect(payload?.text).not.toContain("undefined");
  });

  it("reports multiple active reviews as a data problem instead of queueing another article", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "multiple_active_reviews",
      activeCount: 2,
      conflictingRows: [4, 9],
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text?.toLowerCase()).toMatch(/несколько|конфликт|поврежд/);
    expect(payload?.text).toContain("4");
    expect(payload?.text).toContain("9");
    expect(payload?.text).toContain("gid=910000001&range=A4:AO4");
    expect(payload?.text).toContain("gid=910000001&range=A9:AO9");
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

  it("shows the existing article while its generation is still in progress", async () => {
    const test = botHarness({
      outcome: "blocked",
      reason: "generation_in_progress",
      keywordId: "KW-IN-PROGRESS",
      articleId: "SEO-IN-PROGRESS",
      rowNumber: 15,
      activeCount: 1,
    });

    await test.bot.handleUpdate(generateUpdate(-5484259760));

    const payload = sentMessagePayload(test);
    expect(payload?.parse_mode).toBe("HTML");
    expect(payload?.text).toContain("SEO-IN-PROGRESS");
    expect(payload?.text?.toLowerCase()).toMatch(/генерир|дожд/);
    expect(payload?.text).toContain("/generate");
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
    expect(test.listArticles).not.toHaveBeenCalled();
    expect(test.findArticle).not.toHaveBeenCalled();
  });

  it("rejects /regenerate without a nonblank comment", async () => {
    const test = botHarness();
    await test.bot.handleUpdate(commandUpdate("regenerate", "   ", { replyMessageId: 12 }));

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.findArticleByTelegramMessageId).not.toHaveBeenCalled();
    expect(test.listArticles).not.toHaveBeenCalled();
    expect(String(sentMessagePayload(test)?.text ?? "").toLowerCase()).toContain("коммент");
  });

  it.each(["needs_review", "failed_qa"] as const)(
    "regenerates the sole active %s article immediately when the command is not a reply",
    async (status) => {
      const onlyActiveArticle = reviewArticle({
        __rowNumber: 9,
        article_id: `SEO-TG-ONLY-${status}`,
        status,
        telegram_message_id: status === "needs_review" ? "75" : "",
      });
      const test = botHarness(queuedGenerationResult, {
        reviewArticles: [onlyActiveArticle],
      });

      await test.bot.handleUpdate(commandUpdate("regenerate", "сделай статью дружелюбнее и теплее"));

      expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
      expect(test.regenerateArticle).toHaveBeenCalledWith({
        articleId: `SEO-TG-ONLY-${status}`,
        feedback: "сделай статью дружелюбнее и теплее",
        actorId: 42,
        actorName: "Owner",
        providerObjectId: "message:-5484259760:78",
      });
      expect(test.findArticleByTelegramMessageId).not.toHaveBeenCalled();
      expect(test.findArticle).not.toHaveBeenCalled();
    },
  );

  it("still regenerates when the immediate acknowledgement cannot be delivered", async () => {
    const test = botHarness(queuedGenerationResult, { failSendMessageCalls: [1] });

    await test.bot.handleUpdate(commandUpdate("regenerate", "сделай вступление теплее"));

    expect(test.regenerateArticle).toHaveBeenCalledWith(expect.objectContaining({
      articleId: "SEO-TG-1",
      feedback: "сделай вступление теплее",
    }));
    expect(test.apiCalls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
  });

  it("does not claim that the old draft was preserved when only the final Telegram reply fails", async () => {
    const test = botHarness(queuedGenerationResult, { failSendMessageCalls: [2] });

    await expect(
      test.bot.handleUpdate(commandUpdate("regenerate", "сделай вступление теплее")),
    ).rejects.toThrow("sendMessage 2 failed");

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    const texts = test.apiCalls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String((call.payload as { text?: string }).text ?? ""));
    expect(texts).toHaveLength(2);
    expect(texts.join("\n")).not.toContain("Старый черновик сохранён");
  });

  it("does not regenerate without a reply when no review card can be selected", async () => {
    const test = botHarness(queuedGenerationResult, {
      reviewArticles: [],
    });

    await test.bot.handleUpdate(commandUpdate("regenerate", "перепиши вступление"));

    expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.findArticleByTelegramMessageId).not.toHaveBeenCalled();
    expect(String(sentMessagePayload(test)?.text ?? "").toLowerCase()).toMatch(/нет|не найден|карточ/);
  });

  it("fails closed when more than one active review article exists", async () => {
    const test = botHarness(queuedGenerationResult, {
      reviewArticles: [
        reviewArticle({ __rowNumber: 4, article_id: "SEO-TG-ACTIVE-1", status: "needs_review", telegram_message_id: 75 }),
        reviewArticle({ __rowNumber: 9, article_id: "SEO-TG-ACTIVE-2", status: "failed_qa", telegram_message_id: 70 }),
      ],
    });

    await test.bot.handleUpdate(commandUpdate("regenerate", "перепиши вступление"));

    expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
    expect(test.regenerateArticle).not.toHaveBeenCalled();
    const text = String(sentMessagePayload(test)?.text ?? "");
    expect(text.toLowerCase()).toMatch(/несколько|однозначно|поврежд/);
    expect(text).toContain("SEO-TG-ACTIVE-1");
    expect(text).toContain("SEO-TG-ACTIVE-2");
    expect(text).toContain("gid=910000001&range=A4:AO4");
    expect(text).toContain("gid=910000001&range=A9:AO9");
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
