import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { booleanCell, stringCell, type Article } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { ApprovalResult, ApprovalService, TelegramActor } from "../services/approval-service.js";
import type {
  GenerationService,
  ManualGenerationBlockReason,
  ManualGenerationResult,
  RegenerationResult,
} from "../services/generation-service.js";
import { articleStatusMessage, escapeHtml } from "./messages.js";

export type SeoBot = Bot<Context>;

export function createTelegramBot(options: {
  config: AppConfig;
  store: GoogleSheetsStore;
  approvals: ApprovalService;
  generation: GenerationService;
  logger: Logger;
}): SeoBot {
  const { config, store, approvals, generation, logger } = options;
  const bot = new Bot(config.telegramBotToken);

  bot.command("seo_help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Playroom SEO bot</b>",
        "/generate [--locale sr|en] KEYWORD — создать статью",
        "/seo_regenerate ARTICLE-ID [пожелание] — исправить черновик ИИ",
        "/seo_approve ARTICLE-ID — согласовать",
        "/seo_status ARTICLE-ID — актуальный статус",
        "/seo_cancel ARTICLE-ID причина — отменить",
        "/seo_chat_id — показать ID этой группы",
        "",
        "ARTICLE-ID можно не указывать, если команда отправлена ответом на карточку статьи.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("seo_chat_id", async (ctx) => {
    if (ctx.chat.type === "private") {
      await ctx.reply("Добавьте меня в review-группу и выполните эту команду там.");
      return;
    }
    await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" });
  });

  bot.command("generate", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const parsed = parseGenerateCommand(commandArgs(ctx));
    if (parsed.outcome === "invalid") {
      await ctx.reply(generateUsage(parsed.message));
      return;
    }
    const actor = actorFromContext(ctx);
    try {
      const result = await generation.requestManualGeneration({
        keyword: parsed.keyword,
        ...(parsed.locale ? { locale: parsed.locale } : {}),
        actorId: actor.id,
        actorName: actor.displayName,
        providerObjectId: actor.providerObjectId,
      });
      await replyGenerationResult(ctx, result);
    } catch (error) {
      logger.error(
        { updateId: ctx.update.update_id, err: error instanceof Error ? error.message : String(error) },
        "Manual generation request failed",
      );
      await ctx.reply("⚠️ Не удалось поставить статью в очередь. Попробуйте ещё раз позже.");
    }
  });

  bot.command("seo_status", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const article = await resolveArticle(ctx, store, commandArgs(ctx));
    if (!article) return;
    await ctx.reply(articleStatusMessage(article), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("seo_approve", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const article = await resolveArticle(ctx, store, commandArgs(ctx));
    if (!article) return;
    const result = await approvals.approve(article.article_id, actorFromContext(ctx));
    await replyApprovalResult(ctx, result);
  });

  bot.command("seo_regenerate", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const raw = commandArgs(ctx);
    const replyMessageId = ctx.message?.reply_to_message?.message_id;
    let article: Article | undefined;
    let feedback = "";
    if (replyMessageId) {
      article = await store.findArticleByTelegramMessageId(replyMessageId);
      feedback = raw;
    } else {
      const [articleId = "", ...feedbackParts] = raw.split(/\s+/);
      article = articleId ? await store.findArticle(articleId) : undefined;
      feedback = feedbackParts.join(" ");
    }
    if (!article) {
      await ctx.reply("❓ Не удалось определить статью. Ответьте на карточку или укажите ARTICLE-ID.");
      return;
    }
    try {
      const result = await generation.regenerateArticle({
        articleId: article.article_id,
        ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        ...generationActorFromContext(ctx),
      });
      await replyRegenerationResult(ctx, result);
    } catch (error) {
      logger.error(
        { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
        "Article regeneration failed",
      );
      await ctx.reply("⚠️ Исправить статью не удалось. Старый черновик сохранён; попробуйте ещё раз позже.");
    }
  });

  bot.command("seo_cancel", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const raw = commandArgs(ctx);
    const replyMessageId = ctx.message?.reply_to_message?.message_id;
    let article: Article | undefined;
    let reason: string;
    if (replyMessageId) {
      article = await store.findArticleByTelegramMessageId(replyMessageId);
      reason = raw;
    } else {
      const [articleId = "", ...reasonParts] = raw.split(/\s+/);
      article = articleId ? await store.findArticle(articleId) : undefined;
      reason = reasonParts.join(" ");
    }
    if (!article) {
      await ctx.reply("❓ Не удалось определить статью. Ответьте на карточку или укажите ARTICLE-ID.");
      return;
    }
    if (!reason.trim()) {
      await ctx.reply("Укажите причину отмены после команды.");
      return;
    }
    const cancelled = await approvals.cancel(article.article_id, reason.trim(), actorFromContext(ctx));
    await ctx.reply(`🛑 <b>${escapeHtml(cancelled.article_id)}</b> отменена.`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^seo:(approve|regenerate|status):(.+)$/, async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const match = ctx.match;
    const action = match[1];
    const articleId = match[2];
    if (!articleId) return;
    const article = await store.findArticle(articleId);
    if (!article) {
      await ctx.answerCallbackQuery({ text: "Статья не найдена", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    if (action === "status") {
      await ctx.reply(articleStatusMessage(article), { parse_mode: "HTML" });
      return;
    }
    if (action === "regenerate") {
      try {
        const result = await generation.regenerateArticle({
          articleId: article.article_id,
          ...generationActorFromContext(ctx),
        });
        await replyRegenerationResult(ctx, result);
      } catch (error) {
        logger.error(
          { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
          "Article regeneration failed",
        );
        await ctx.reply("⚠️ Исправить статью не удалось. Старый черновик сохранён; попробуйте ещё раз позже.");
      }
      return;
    }
    const result = await approvals.approve(article.article_id, actorFromContext(ctx));
    await replyApprovalResult(ctx, result);
  });

  bot.catch((error) => {
    logger.error(
      { updateId: error.ctx.update.update_id, err: error.error instanceof Error ? error.error.message : String(error.error) },
      "Telegram update failed",
    );
  });
  return bot;
}

export const telegramCommandMenu = [
  { command: "generate", description: "Создать новую SEO-статью" },
  { command: "seo_status", description: "Показать статус статьи" },
  { command: "seo_regenerate", description: "Исправить черновик с помощью ИИ" },
  { command: "seo_approve", description: "Согласовать статью" },
  { command: "seo_cancel", description: "Отменить статью с причиной" },
  { command: "seo_help", description: "Показать справку" },
  { command: "seo_chat_id", description: "Показать ID review-группы" },
] as const;

export type ParsedGenerateCommand =
  | { outcome: "valid"; keyword: string; locale?: string }
  | { outcome: "invalid"; message: string };

export function parseGenerateCommand(raw: string): ParsedGenerateCommand {
  const normalized = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return { outcome: "invalid", message: "Укажите ключевую фразу." };

  let keyword = normalized;
  let locale: string | undefined;
  if (normalized.startsWith("--")) {
    const match = normalized.match(/^--locale(?:=|\s+)([a-z]{2})(?:\s*[|:]\s*|\s+)(.+)$/iu);
    if (!match) return { outcome: "invalid", message: "Не удалось разобрать параметр locale." };
    locale = match[1]?.toLowerCase();
    keyword = match[2] ?? "";
  } else if (/^(sr|en|ru)$/iu.test(normalized)) {
    return { outcome: "invalid", message: "После locale укажите ключевую фразу через --locale." };
  }

  keyword = keyword.replace(/\s+/gu, " ").trim();
  if (keyword.length < 2 || keyword.length > 200 || /[\u0000-\u001F\u007F]/u.test(keyword)) {
    return { outcome: "invalid", message: "Ключ должен содержать от 2 до 200 символов." };
  }
  return { outcome: "valid", keyword, ...(locale ? { locale } : {}) };
}

export function reviewKeyboard(article: Article): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Согласовать", `seo:approve:${article.article_id}`)
    .text("🔄 Исправить ИИ", `seo:regenerate:${article.article_id}`)
    .text("ℹ️ Статус", `seo:status:${article.article_id}`);
}

async function authorizeReviewChat(
  ctx: Context,
  config: AppConfig,
  store: GoogleSheetsStore,
): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Эта команда работает только в настроенной review-группе.");
    return false;
  }
  const settings = await store.getSettings();
  const fromSheet = Number(settings.get("telegram_chat_id"));
  const allowedChatId = config.telegramReviewChatId ?? (Number.isSafeInteger(fromSheet) ? fromSheet : undefined);
  if (!allowedChatId) {
    await ctx.reply("Review-группа ещё не привязана. Выполните /seo_chat_id и внесите ID в settings.");
    return false;
  }
  if (ctx.chat.id !== allowedChatId) {
    await ctx.reply("Эта группа не настроена как review-группа.");
    return false;
  }
  if (!ctx.from || ctx.from.is_bot) return false;
  return true;
}

async function resolveArticle(
  ctx: Context,
  store: GoogleSheetsStore,
  explicitId: string,
): Promise<Article | undefined> {
  const article = explicitId
    ? await store.findArticle(explicitId.split(/\s+/)[0] ?? "")
    : ctx.message?.reply_to_message?.message_id
      ? await store.findArticleByTelegramMessageId(ctx.message.reply_to_message.message_id)
      : undefined;
  if (!article) {
    await ctx.reply("❓ Не удалось определить статью. Ответьте на карточку или укажите ARTICLE-ID.");
  }
  return article;
}

function commandArgs(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function actorFromContext(ctx: Context): TelegramActor {
  const from = ctx.from;
  if (!from) throw new Error("Telegram actor is missing");
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const providerObjectId = ctx.callbackQuery?.id
    ? `callback:${ctx.callbackQuery.id}`
    : ctx.message?.message_id && ctx.chat
      ? `message:${ctx.chat.id}:${ctx.message.message_id}`
      : undefined;
  if (!providerObjectId) throw new Error("Telegram command ID is missing");
  return {
    id: from.id,
    ...(from.username ? { username: from.username } : {}),
    displayName,
    providerObjectId,
  };
}

function generationActorFromContext(ctx: Context): {
  actorId: number;
  actorName: string;
  providerObjectId: string;
} {
  const actor = actorFromContext(ctx);
  return {
    actorId: actor.id,
    actorName: actor.displayName,
    providerObjectId: actor.providerObjectId,
  };
}

async function replyApprovalResult(ctx: Context, result: ApprovalResult): Promise<void> {
  if (result.outcome === "approved") {
    await ctx.reply(`✅ <b>${escapeHtml(result.article.article_id)}</b> согласована.`, { parse_mode: "HTML" });
    return;
  }
  if (result.outcome === "already_approved") {
    await ctx.reply(`ℹ️ <b>${escapeHtml(result.article.article_id)}</b> уже согласована; дубль не создан.`, {
      parse_mode: "HTML",
    });
    return;
  }
  if (result.outcome === "blocked") {
    await ctx.reply(
      `⛔ Согласование не выполнено.\nQA blockers: <code>${escapeHtml(result.quality.blockers.join(", "))}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  await ctx.reply(
    `⛔ Текущий статус <code>${escapeHtml(result.article.status)}</code>; требуется <code>needs_review</code>.`,
    { parse_mode: "HTML" },
  );
}

async function replyGenerationResult(ctx: Context, result: ManualGenerationResult): Promise<void> {
  if (result.outcome === "blocked") {
    await ctx.reply(manualGenerationBlockedMessage(result.reason, result.locale));
    return;
  }
  if (result.outcome === "already_generated") {
    await ctx.reply(
      [
        `ℹ️ По этому ключу уже создана статья <code>${escapeHtml(result.articleId)}</code>.`,
        `Проверить: <code>/seo_status ${escapeHtml(result.articleId)}</code>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }
  if (result.outcome === "previous_failed") {
    await ctx.reply(
      `⚠️ Предыдущая генерация <code>${escapeHtml(result.keywordId)}</code> завершилась ошибкой. Проверьте строку keywords; автоматический повтор не запущен.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (result.outcome === "already_queued") {
    await ctx.reply(`ℹ️ Такой запрос уже в очереди: <code>${escapeHtml(result.keywordId)}</code>.`, {
      parse_mode: "HTML",
    });
    return;
  }
  await ctx.reply(
    [
      `🧠 Принял запрос «${escapeHtml(result.keyword)}» · ${escapeHtml(result.locale.toUpperCase())}`,
      `Keyword ID: <code>${escapeHtml(result.keywordId)}</code>`,
      "Карточка появится в этой группе после генерации и QA.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

async function replyRegenerationResult(ctx: Context, result: RegenerationResult): Promise<void> {
  if (result.outcome === "blocked") {
    if (result.reason === "generator_not_configured") {
      await ctx.reply("⛔ Генератор пока не настроен.");
      return;
    }
    if (result.reason === "manual_generation_disabled") {
      await ctx.reply("⛔ Исправление ИИ сейчас выключено администратором.");
      return;
    }
    if (result.reason === "ru_disabled") {
      await ctx.reply("⛔ RU-генерация выключена до готовности русского раздела сайта.");
      return;
    }
    if (result.reason === "locale_disabled") {
      await ctx.reply("⛔ Локаль этой статьи сейчас выключена.");
      return;
    }
    if (result.reason === "no_internal_links") {
      await ctx.reply("⛔ Для локали статьи нет активных разрешённых внутренних ссылок.");
      return;
    }
    await ctx.reply(
      `⛔ Статью в статусе <code>${escapeHtml(String(result.article?.status ?? "unknown"))}</code> нельзя перегенерировать.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (result.outcome === "already_regenerated") {
    await ctx.reply(`ℹ️ <b>${escapeHtml(result.article.article_id)}</b> уже исправлена по этой команде.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const passed = stringCell(result.article.qa_status) === "pass" && !booleanCell(result.article.manual_required);
  await ctx.reply(
    passed
      ? `✅ <b>${escapeHtml(result.article.article_id)}</b> исправлена и прошла QA. Карточка обновится автоматически.`
      : `⚠️ <b>${escapeHtml(result.article.article_id)}</b> обновлена, но QA всё ещё нашла замечания. Карточка обновится автоматически.`,
    { parse_mode: "HTML" },
  );
}

function manualGenerationBlockedMessage(reason: ManualGenerationBlockReason, locale?: string): string {
  if (reason === "generator_not_configured") return "⛔ Генератор пока не настроен.";
  if (reason === "manual_generation_disabled") return "⛔ Ручная генерация сейчас выключена администратором.";
  if (reason === "invalid_keyword") return generateUsage("Ключ должен содержать от 2 до 200 символов.");
  if (reason === "ru_disabled") return "⛔ RU-генерация выключена до готовности русского раздела сайта.";
  if (reason === "no_internal_links") {
    return `⛔ Для ${String(locale ?? "этой локали").toUpperCase()} нет разрешённых внутренних ссылок.`;
  }
  if (reason === "queue_full") return "⛔ Очередь ручной генерации заполнена. Дождитесь ближайшей карточки.";
  return `⛔ Локаль ${String(locale ?? "").toUpperCase() || "не настроена"} недоступна.`;
}

function generateUsage(message: string): string {
  return [
    message,
    "",
    "Примеры:",
    "/generate igraonice za decu Beograd",
    "/generate --locale en kids playrooms Belgrade",
  ].join("\n");
}
