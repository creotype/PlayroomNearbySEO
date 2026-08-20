import { Bot, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { booleanCell, stringCell, type Article } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { ApprovalResult, ApprovalService, TelegramActor } from "../services/approval-service.js";
import type {
  GenerationService,
  InvalidKeywordField,
  ManualGenerationResult,
  RegenerationResult,
} from "../services/generation-service.js";
import {
  articleSheetUrl,
  escapeHtml,
  keywordSheetUrl,
  linkInventorySheetUrl,
  settingsSheetUrl,
} from "./messages.js";
import { UpdateDrain } from "./update-drain.js";

export type SeoBot = Bot<Context>;
const updateDrains = new WeakMap<SeoBot, UpdateDrain>();

export function waitForTelegramIdle(bot: SeoBot): Promise<void> {
  return updateDrains.get(bot)?.wait() ?? Promise.resolve();
}

export function createTelegramBot(options: {
  config: AppConfig;
  store: GoogleSheetsStore;
  approvals: ApprovalService;
  generation: GenerationService;
  logger: Logger;
}): SeoBot {
  const { config, store, approvals, generation, logger } = options;
  const bot = new Bot(config.telegramBotToken);
  const updateDrain = new UpdateDrain();
  updateDrains.set(bot, updateDrain);
  bot.use(async (_ctx, next) => {
    const leave = updateDrain.enter();
    try {
      await next();
    } finally {
      leave();
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Playroom SEO bot</b>",
        "",
        "Я беру ключевики из Google Sheets, пишу SEO-статьи и после согласования публикую их в Ghost.",
        "",
        "/generate — взять следующую ready-строку из таблицы",
        "/regenerate замечания — переписать текущую статью на ревью",
        "/approve — ответом на карточку согласовать и отправить на публикацию",
        "",
        "Бот ведёт только одну статью за раз. У /regenerate комментарий обязателен. /approve отправляется reply на карточку без текста после команды.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
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
        actorId: actor.id,
        actorName: actor.displayName,
        providerObjectId: actor.providerObjectId,
      });
      await replyGenerationResult(ctx, result, config);
    } catch (error) {
      logger.error(
        { updateId: ctx.update.update_id, err: error instanceof Error ? error.message : String(error) },
        "Manual generation request failed",
      );
      await ctx.reply("⚠️ Не удалось поставить статью в очередь. Попробуйте ещё раз позже.");
    }
  });

  bot.command("approve", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    if (commandArgs(ctx)) {
      await ctx.reply("Отправьте только /approve ответом на карточку статьи — без ARTICLE-ID и другого текста.");
      return;
    }
    const replyMessageId = ctx.message?.reply_to_message?.message_id;
    if (!replyMessageId) {
      await ctx.reply("Ответьте на карточку статьи командой /approve.");
      return;
    }
    const article = await store.findArticleByTelegramMessageId(replyMessageId);
    if (!article) {
      await ctx.reply("❓ Это не карточка статьи. Ответьте /approve именно на сообщение с SEO draft.");
      return;
    }
    const result = await approvals.approve(article.article_id, actorFromContext(ctx));
    await replyApprovalResult(ctx, result);
  });

  bot.command("regenerate", async (ctx) => {
    if (!(await authorizeReviewChat(ctx, config, store))) return;
    const feedback = commandArgs(ctx);
    if (!feedback) {
      await ctx.reply("Добавьте замечания после команды: /regenerate ваш комментарий.");
      return;
    }
    const replyMessageId = ctx.message?.reply_to_message?.message_id;
    const activeReviews = replyMessageId
      ? undefined
      : await store.listArticles(["needs_review", "failed_qa"]);
    const article = replyMessageId
      ? await store.findArticleByTelegramMessageId(replyMessageId)
      : soleActiveReviewArticle(activeReviews ?? []);
    if (!article) {
      if (replyMessageId) {
        await ctx.reply("❓ Это не карточка статьи. Ответьте /regenerate с замечаниями именно на сообщение с SEO draft.");
        return;
      }
      if ((activeReviews?.length ?? 0) > 1) {
        const rows = activeReviews!
          .map((candidate) =>
            `<a href="${articleSheetUrl(config.spreadsheetId, candidate.__rowNumber)}">${escapeHtml(candidate.article_id)} · строка ${candidate.__rowNumber}</a>`,
          )
          .join("\n");
        await ctx.reply(
          [
            "⛔ <b>В таблице несколько активных статей.</b> Я не буду угадывать, какую переписывать.",
            rows,
            "Завершите лишние строки или ответьте командой на карточку нужной статьи.",
          ].join("\n"),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        return;
      }
      await ctx.reply("❓ Не нашёл активную статью на ревью. Сначала дождитесь карточки после /generate.");
      return;
    }
    try {
      await ctx.reply(`🧠 Принял комментарий для <b>${escapeHtml(article.article_id)}</b>. Переписываю статью…`, {
        parse_mode: "HTML",
      });
    } catch (error) {
      logger.warn(
        { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
        "Could not send regeneration acknowledgement",
      );
    }
    let result: RegenerationResult;
    try {
      result = await generation.regenerateArticle({
        articleId: article.article_id,
        feedback,
        ...generationActorFromContext(ctx),
      });
    } catch (error) {
      logger.error(
        { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
        "Article regeneration failed",
      );
      await ctx.reply("⚠️ Исправить статью не удалось. Старый черновик сохранён; попробуйте ещё раз позже.");
      return;
    }
    await replyRegenerationResult(ctx, result);
  });

  bot.catch((error) => {
    logger.error(
      { updateId: error.ctx.update.update_id, err: error.error instanceof Error ? error.error.message : String(error.error) },
      "Telegram update failed",
    );
  });
  return bot;
}

function soleActiveReviewArticle(articles: Article[]): Article | undefined {
  return articles.length === 1 ? articles[0] : undefined;
}

export const telegramCommandMenu = [
  { command: "generate", description: "Сгенерировать следующую статью" },
  { command: "regenerate", description: "Переписать по комментарию" },
  { command: "approve", description: "Согласовать статью" },
  { command: "help", description: "Как работает бот" },
] as const;

export type ParsedGenerateCommand =
  | { outcome: "valid" }
  | { outcome: "invalid"; message: string };

export function parseGenerateCommand(raw: string): ParsedGenerateCommand {
  const normalized = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return { outcome: "valid" };
  return {
    outcome: "invalid",
    message: "/generate больше не принимает ключевик. Бот сам берёт верхнюю ready-строку.",
  };
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
    await ctx.reply("Review-группа ещё не привязана. Передайте ID группы техническому администратору.");
    return false;
  }
  if (ctx.chat.id !== allowedChatId) {
    await ctx.reply("Эта группа не настроена как review-группа.");
    return false;
  }
  if (!ctx.from || ctx.from.is_bot) return false;
  return true;
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

async function replyGenerationResult(
  ctx: Context,
  result: ManualGenerationResult,
  config: Pick<AppConfig, "spreadsheetId" | "targetEnvironment">,
): Promise<void> {
  if (result.outcome === "blocked") {
    await ctx.reply(manualGenerationBlockedMessage(result, config), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return;
  }
  if (result.outcome === "already_generated") {
    await ctx.reply(
      [
        `ℹ️ По этому ключу уже создана статья <code>${escapeHtml(result.articleId)}</code>.`,
        "Её review-карточка уже была отправлена в эту группу.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }
  if (result.outcome === "previous_failed") {
    const sheetUrl = keywordSheetUrl(config.spreadsheetId, result.rowNumber);
    await ctx.reply(
      [
        `⚠️ Предыдущая генерация <code>${escapeHtml(result.keywordId)}</code> завершилась ошибкой.`,
        "Исправьте данные при необходимости, очистите <code>article_id</code>, верните <code>status=ready</code> и снова отправьте <code>/generate</code>.",
        "",
        `<a href="${sheetUrl}">Открыть строку в Google Sheets</a>`,
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }
  if (result.outcome === "already_queued") {
    const sheetUrl = keywordSheetUrl(config.spreadsheetId, result.rowNumber);
    await ctx.reply(
      `ℹ️ Такой запрос уже в очереди: <code>${escapeHtml(result.keywordId)}</code>.\n<a href="${sheetUrl}">Открыть строку</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }
  await ctx.reply(
    [
      `🧠 Взял следующий ключ «${escapeHtml(result.keyword)}» · ${escapeHtml(result.locale.toUpperCase())}`,
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

function manualGenerationBlockedMessage(
  result: Extract<ManualGenerationResult, { outcome: "blocked" }>,
  config: Pick<AppConfig, "spreadsheetId" | "targetEnvironment">,
): string {
  const queueUrl = keywordSheetUrl(config.spreadsheetId);
  const rowUrl = keywordSheetUrl(config.spreadsheetId, result.rowNumber);
  const articleUrl = articleSheetUrl(config.spreadsheetId, result.rowNumber);
  const settingsUrl = settingsSheetUrl(config.spreadsheetId);
  const linkInventoryUrl = linkInventorySheetUrl(config.spreadsheetId);
  const rowTitle = result.rowNumber ? `Строка ${result.rowNumber}` : "Верхняя ready-строка";
  const retry = "Исправьте строку, оставьте <code>status=ready</code> и снова отправьте <code>/generate</code>.";
  const openRow = result.rowNumber
    ? `<a href="${rowUrl}">Исправить строку ${result.rowNumber} в Google Sheets</a>`
    : `<a href="${queueUrl}">Открыть keywords в Google Sheets</a>`;

  if (result.reason === "generator_not_configured") {
    return "⛔ <b>Генератор не настроен на сервере.</b> Это не ошибка ключевика — передайте сообщение техническому администратору.";
  }
  if (result.reason === "manual_generation_disabled") {
    return [
      "⛔ <b>Ручная генерация выключена.</b>",
      "Проверьте <code>settings.telegram_generation_enabled</code>. Если там <code>TRUE</code>, нужен технический администратор для серверного переключателя.",
      "",
      `<a href="${settingsUrl}">Открыть settings</a>`,
    ].join("\n");
  }
  if (result.reason === "no_ready_keywords") {
    return [
      "📭 <b>В очереди нет готовых ключевиков.</b>",
      "В <code>keywords</code> нет строк с точным <code>status=ready</code>.",
      "Заполните <code>keyword_id</code>, <code>locale</code> и <code>primary_keyword</code>, оставьте <code>article_id</code> пустым и поставьте <code>ready</code>.",
      "",
      `<a href="${queueUrl}">Открыть очередь keywords</a>`,
    ].join("\n");
  }
  if (result.reason === "active_review_exists") {
    return [
      "⏸ <b>Сначала закончите предыдущую статью.</b>",
      `<code>${escapeHtml(result.articleId ?? "без ID")}</code> всё ещё ждёт решения. Новая статья не создана.`,
      "Чтобы исправить её, отправьте <code>/regenerate ваш комментарий</code>. Чтобы согласовать — ответьте <code>/approve</code> на карточку выше.",
      "После согласования <code>/generate</code> возьмёт следующий ключевик.",
      "",
      `<a href="${articleUrl}">Открыть предыдущую статью в Google Sheets</a>`,
    ].join("\n");
  }
  if (result.reason === "multiple_active_reviews") {
    const rows = (result.conflictingRows ?? []).join(", ") || "не определены";
    const rowLinks = (result.conflictingRows ?? [])
      .map((row) => `<a href="${articleSheetUrl(config.spreadsheetId, row)}">Строка ${row}</a>`)
      .join(" · ");
    return [
      "⛔ <b>В таблице несколько активных статей.</b>",
      `Строки <code>articles</code>: <code>${escapeHtml(rows)}</code>. Бот не создал ещё одну статью.`,
      "Оставьте только одну статью в статусе <code>needs_review</code> или <code>failed_qa</code>; остальные сначала завершите или передайте администратору.",
      "",
      rowLinks || `<a href="${articleSheetUrl(config.spreadsheetId)}">Открыть articles в Google Sheets</a>`,
    ].join("\n");
  }
  if (result.reason === "generation_in_progress") {
    return [
      "⏳ <b>Предыдущая статья ещё генерируется.</b>",
      result.articleId
        ? `Текущий article ID: <code>${escapeHtml(result.articleId)}</code>.`
        : "Бот уже обрабатывает предыдущий ключевик.",
      "Дождитесь review-карточки — повторять <code>/generate</code> не нужно.",
      "",
      openRow,
    ].join("\n");
  }
  if (result.reason === "invalid_keyword_row") {
    const invalidHeader = result.rowNumber
      ? `/generate остановлен на строке ${result.rowNumber}.`
      : "/generate остановлен на верхней ready-строке.";
    const issues = (result.invalidFields ?? []).map((field) => invalidKeywordFieldMessage(
      field,
      result.rowNumber,
      result.articleId,
    ));
    return [
      `⛔ <b>${invalidHeader}</b>`,
      "Бот не пропустил сломанный верхний ключ, чтобы не нарушить порядок очереди.",
      ...issues.map((issue) => `• ${issue}`),
      retry,
      "",
      openRow,
    ].join("\n");
  }
  if (result.reason === "duplicate_keyword_id") {
    const rows = (result.conflictingRows ?? []).join(", ") || "не определены";
    const rowLinks = (result.conflictingRows ?? [])
      .map((row) => `<a href="${keywordSheetUrl(config.spreadsheetId, row)}">Строка ${row}</a>`)
      .join(" · ");
    return [
      `⛔ <b>Дублирующийся keyword_id · ${rowTitle}.</b>`,
      `<code>${escapeHtml(result.keywordId ?? "пусто")}</code> встречается в строках: <code>${escapeHtml(rows)}</code>.`,
      "Задайте каждой строке уникальный <code>keyword_id</code> и повторите <code>/generate</code>.",
      "",
      rowLinks || openRow,
    ].join("\n");
  }
  if (result.reason === "keyword_row_changed") {
    return [
      `↻ <b>${rowTitle} изменилась во время запуска.</b>`,
      "Бот ничего не перезаписал. Проверьте, что <code>status=ready</code>, <code>article_id</code> пустой, а <code>locale</code> и <code>primary_keyword</code> заполнены, затем повторите <code>/generate</code>.",
      "",
      openRow,
    ].join("\n");
  }
  if (result.reason === "request_conflict") {
    return [
      `⛔ <b>Конфликт системной заявки · ${rowTitle}.</b>`,
      `Текущий <code>article_id</code>: <code>${escapeHtml(result.articleId ?? "пусто")}</code>. Подпись Telegram-заявки не совпадает с данными строки.`,
      "Не редактируйте <code>events</code> вручную; откройте строку и передайте её техническому администратору.",
      "",
      openRow,
    ].join("\n");
  }
  if (result.reason === "ru_disabled") {
    return [
      `⛔ <b>${rowTitle}: указана RU, но русский раздел выключен.</b>`,
      "Исправьте <code>locale</code> или, если русский раздел уже готов, попросите администратора включить <code>settings.ru_enabled</code>.",
      "",
      openRow,
      `<a href="${settingsUrl}">Открыть settings</a>`,
    ].join("\n");
  }
  if (result.reason === "locale_disabled") {
    const allowed = (result.allowedLocales ?? []).map((locale) => locale.toUpperCase()).join(", ") || "не настроены";
    return [
      `⛔ <b>${rowTitle}: локаль недоступна.</b>`,
      `Сейчас в <code>settings.enabled_locales</code> разрешены: <code>${escapeHtml(allowed)}</code>.`,
      `Исправьте <code>locale=${escapeHtml((result.locale ?? "пусто").toUpperCase())}</code> либо согласуйте включение локали с администратором.`,
      "",
      openRow,
      `<a href="${settingsUrl}">Открыть settings</a>`,
    ].join("\n");
  }
  if (result.reason === "no_internal_links") {
    const environment = config.targetEnvironment || "текущее окружение";
    return [
      `⛔ <b>Для ${(result.locale ?? "локали").toUpperCase()} нет разрешённой внутренней ссылки.</b>`,
      `В <code>link_inventory</code> нужна строка: <code>environment=${escapeHtml(environment)}</code>, нужная locale или <code>all</code>, <code>status=active</code>, <code>allow_internal_link=TRUE</code>.`,
      "",
      openRow,
      `<a href="${linkInventoryUrl}">Открыть link_inventory</a>`,
    ].join("\n");
  }
  return "⛔ Не удалось определить причину блокировки. Повторите команду позже или передайте сообщение техническому администратору.";
}

function invalidKeywordFieldMessage(
  field: InvalidKeywordField,
  rowNumber?: number,
  articleId?: string,
): string {
  const row = rowNumber ?? "?";
  if (field === "keyword_id") {
    return `<code>A${row} keyword_id</code> пустой. Заполните уникальный ID, например <code>KW-SR-011</code>.`;
  }
  if (field === "locale") {
    return `<code>B${row} locale</code> пустая. Укажите включённую локаль, обычно <code>sr</code> или <code>en</code>.`;
  }
  if (field === "primary_keyword") {
    return `<code>C${row} primary_keyword</code> должен содержать 2–200 обычных символов без невидимых управляющих знаков.`;
  }
  return `<code>O${row} article_id</code> должен быть пустым при <code>status=ready</code>; сейчас: <code>${escapeHtml(articleId ?? "заполнен")}</code>. Если статья уже создавалась, восстановите правильный status вместо создания дубля.`;
}

function generateUsage(message: string): string {
  return [
    message,
    "",
    "Отправьте только:",
    "/generate",
  ].join("\n");
}
