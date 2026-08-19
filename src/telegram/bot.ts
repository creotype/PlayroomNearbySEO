import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { Article } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { ApprovalResult, ApprovalService, TelegramActor } from "../services/approval-service.js";
import { articleStatusMessage, escapeHtml } from "./messages.js";

export type SeoBot = Bot<Context>;

export function createTelegramBot(options: {
  config: AppConfig;
  store: GoogleSheetsStore;
  approvals: ApprovalService;
  logger: Logger;
}): SeoBot {
  const { config, store, approvals, logger } = options;
  const bot = new Bot(config.telegramBotToken);

  bot.command("seo_help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Playroom SEO bot</b>",
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

  bot.callbackQuery(/^seo:(approve|status):(.+)$/, async (ctx) => {
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

export function reviewKeyboard(articleId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Согласовать", `seo:approve:${articleId}`)
    .text("ℹ️ Статус", `seo:status:${articleId}`);
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
