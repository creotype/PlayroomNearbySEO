import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { articleContentHash, stringCell, type SheetRecord } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { SeoBot } from "../telegram/bot.js";
import { reviewKeyboard } from "../telegram/bot.js";
import { articleCard, escapeHtml, keywordSheetUrl } from "../telegram/messages.js";

export class ReviewNotifier {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly bot: SeoBot,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    const settings = await this.store.getSettings();
    const sheetChatId = Number(settings.get("telegram_chat_id"));
    const chatId = this.config.telegramReviewChatId ?? (Number.isSafeInteger(sheetChatId) ? sheetChatId : undefined);
    if (!chatId) return;
    const articles = await this.store.listArticles(["needs_review"]);
    for (const article of articles) {
      const currentHash = articleContentHash(article);
      const existingMessageId = Number(article.telegram_message_id);
      try {
        if (Number.isSafeInteger(existingMessageId) && existingMessageId > 0) {
          if (stringCell(article.content_hash) === currentHash) continue;
          await this.bot.api.editMessageText(
            chatId,
            existingMessageId,
            articleCard(article, this.config.spreadsheetId),
            { parse_mode: "HTML", reply_markup: reviewKeyboard(article), link_preview_options: { is_disabled: true } },
          );
          await this.store.patchArticle(article.article_id, {
            content_hash: currentHash,
            updated_at: new Date().toISOString(),
          });
          continue;
        }
        const message = await this.bot.api.sendMessage(
          chatId,
          articleCard(article, this.config.spreadsheetId),
          { parse_mode: "HTML", reply_markup: reviewKeyboard(article), link_preview_options: { is_disabled: true } },
        );
        await this.store.patchArticle(article.article_id, {
          telegram_message_id: message.message_id,
          content_hash: currentHash,
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        this.logger.error(
          { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
          "Review notification failed",
        );
      }
    }
    await this.#notifyGenerationFailures(chatId);
  }

  async #notifyGenerationFailures(chatId: number): Promise<void> {
    const keywords = await this.store.listKeywords(["paused"]);
    for (const keyword of keywords) {
      const articleId = stringCell(keyword.article_id);
      if (!articleId) continue;
      const events = await this.store.listEvents(articleId);
      const requestedFromTelegram = events.some(
        (event) =>
          stringCell(event.event_type) === "generation_requested" &&
          stringCell(event.provider) === "telegram",
      );
      if (!requestedFromTelegram) continue;
      const failure = [...events]
        .reverse()
        .find((event) => ["generation_failed", "generation_blocked"].includes(stringCell(event.event_type)));
      if (!failure) continue;
      const notificationEventId = `evt-generation-notified-${stringCell(failure.event_id)}`;
      if (events.some((event) => stringCell(event.event_id) === notificationEventId)) continue;
      try {
        const message = await this.bot.api.sendMessage(
          chatId,
          generationFailureMessage(keyword, failure, this.config.spreadsheetId),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        const now = new Date().toISOString();
        await this.store.appendEvent({
          event_id: notificationEventId,
          article_id: articleId,
          event_type: "generation_failure_notified",
          from_status: "paused",
          to_status: "paused",
          actor_type: "system",
          actor_id: "review-notifier",
          provider: "telegram",
          provider_object_id: String(message.message_id),
          message: `Generation failure notification sent for ${stringCell(keyword.keyword_id)}`,
          payload_json: JSON.stringify({ failure_event_id: stringCell(failure.event_id) }),
          created_at: now,
        });
      } catch (error) {
        this.logger.error(
          { keywordId: stringCell(keyword.keyword_id), err: error instanceof Error ? error.message : String(error) },
          "Generation failure notification failed",
        );
      }
    }
  }
}

function generationFailureMessage(
  keyword: SheetRecord,
  failure: SheetRecord,
  spreadsheetId: string,
): string {
  const row = keyword.__rowNumber;
  const sheetUrl = keywordSheetUrl(spreadsheetId, row);
  const reason = generationFailureReason(failure);
  return [
    `⚠️ <b>Генерация остановлена · ${escapeHtml(stringCell(keyword.keyword_id))}</b>`,
    escapeHtml(stringCell(keyword.primary_keyword)),
    reason,
    "",
    `<a href="${sheetUrl}">Открыть заявку в Google Sheets</a>`,
  ].join("\n");
}

function generationFailureReason(failure: SheetRecord): string {
  const retry = "После исправления очистите article_id, верните status=ready и повторите /generate.";
  if (stringCell(failure.event_type) !== "generation_blocked") {
    return `Генератор вернул техническую ошибку. ${retry}`;
  }
  try {
    const payload = JSON.parse(stringCell(failure.payload_json)) as Record<string, unknown>;
    if (payload.reason === "ru_disabled") {
      return `Локаль RU выключили после постановки в очередь. Исправьте locale или обратитесь к администратору. ${retry}`;
    }
    if (payload.reason === "locale_disabled") {
      return `Локаль ключа выключили после постановки в очередь. Исправьте locale или settings.enabled_locales. ${retry}`;
    }
    if (payload.reason === "no_internal_links") {
      return `Для локали больше нет разрешённой внутренней ссылки. Проверьте link_inventory. ${retry}`;
    }
    if (payload.reason === "invalid_manual_request") {
      return "Системные поля ключа изменились после /generate. Проверьте строку, очистите article_id и верните status=ready для нового запуска.";
    }
  } catch {
    // Fall through to a safe operator-facing explanation.
  }
  return `Настройки или системные поля ключа изменились после постановки в очередь. ${retry}`;
}
