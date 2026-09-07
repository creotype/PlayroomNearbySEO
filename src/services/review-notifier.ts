import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { articleContentHash, stringCell, type SheetRecord } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { SeoBot } from "../telegram/bot.js";
import { articleCard, articleSheetUrl, escapeHtml, keywordSheetUrl } from "../telegram/messages.js";
import { verifyPublicPage, type PublicPageVerification } from "./publication-service.js";

export class ReviewNotifier {
  readonly #clearedReviewMarkup = new Set<number>();

  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly bot: SeoBot,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly publicPageVerifier: (url: string) => Promise<PublicPageVerification> = verifyPublicPage,
  ) {}

  async runOnce(): Promise<void> {
    const settings = await this.store.getSettings();
    const sheetChatId = Number(settings.get("telegram_chat_id"));
    const chatId = this.config.telegramReviewChatId ?? (Number.isSafeInteger(sheetChatId) ? sheetChatId : undefined);
    if (!chatId) return;
    const reviewPolicy = {
      deadlineHours: numberSetting(
        settings.get("review_deadline_hours") ?? settings.get("review_window_hours"),
        this.config.reviewDeadlineHours ?? 48,
      ),
      publicationTime: stringCell(settings.get("publication_time")) || this.config.publicationTime || "10:00",
    };
    const articles = await this.store.listArticles(["needs_review"]);
    for (const article of articles) {
      const currentHash = articleContentHash(article);
      const existingMessageId = Number(article.telegram_message_id);
      try {
        if (Number.isSafeInteger(existingMessageId) && existingMessageId > 0) {
          const contentChanged = stringCell(article.content_hash) !== currentHash;
          const needsMarkupMigration = !this.#clearedReviewMarkup.has(existingMessageId);
          if (!contentChanged && !needsMarkupMigration) continue;
          try {
            await this.bot.api.editMessageText(
              chatId,
              existingMessageId,
              articleCard(article, this.config.spreadsheetId, reviewPolicy),
              {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] },
                link_preview_options: { is_disabled: true },
              },
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (!/message is not modified/iu.test(detail)) throw error;
          }
          this.#clearedReviewMarkup.add(existingMessageId);
          if (contentChanged) {
            await this.store.patchArticle(article.article_id, {
              content_hash: currentHash,
              updated_at: new Date().toISOString(),
            });
          }
          continue;
        }
        const message = await this.bot.api.sendMessage(
          chatId,
          articleCard(article, this.config.spreadsheetId, reviewPolicy),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        this.#clearedReviewMarkup.add(message.message_id);
        await this.store.patchArticle(article.article_id, {
          telegram_message_id: message.message_id,
          content_hash: currentHash,
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (
          Number.isSafeInteger(existingMessageId) &&
          existingMessageId > 0 &&
          /message to edit not found/iu.test(detail)
        ) {
          await this.store.patchArticle(article.article_id, {
            telegram_message_id: "",
            content_hash: "",
            updated_at: new Date().toISOString(),
          });
          this.logger.warn(
            { articleId: article.article_id, telegramMessageId: existingMessageId },
            "Missing review card mapping cleared; notifier will send a replacement",
          );
          continue;
        }
        this.logger.error(
          { articleId: article.article_id, err: detail },
          "Review notification failed",
        );
      }
    }
    await this.#notifyGenerationFailures(chatId);
    const frontendBaseUrl = stringCell(
      settings.get(`${this.config.targetEnvironment}_frontend_base_url`),
    );
    await this.#notifyPublicationOutcomes(chatId, frontendBaseUrl);
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

  async #notifyPublicationOutcomes(chatId: number, frontendBaseUrl: string): Promise<void> {
    const articles = await this.store.listArticles(["published", "failed_publish", "conflict"]);
    for (const article of articles) {
      try {
        if (!["published", "failed_publish", "conflict"].includes(article.status)) continue;
        const events = await this.store.listEvents(article.article_id);
        const hasTrustedApproval = events.some(
          (event) =>
            stringCell(event.event_type) === "approved" &&
            (
              stringCell(event.provider) === "telegram" ||
              (
                stringCell(event.provider) === "system" &&
                stringCell(event.actor_id) === "auto-review-timeout"
              )
            ),
        );
        if (!hasTrustedApproval) continue;
        const expectedEventType = article.status === "published"
          ? "published"
          : article.status === "failed_publish"
            ? "publish_failed"
            : "publication_conflict";
        const outcome = [...events]
          .reverse()
          .find((event) => stringCell(event.event_type) === expectedEventType);
        if (!outcome) continue;
        const outcomeEventId = stringCell(outcome.event_id);
        if (!outcomeEventId) continue;
        const notificationEventId = `evt-publication-notified-${outcomeEventId}`;
        if (events.some((event) => stringCell(event.event_id) === notificationEventId)) continue;
        const recordedPublicUrl = expectedEventType === "published"
          ? trustedPublishedPublicUrl(article, outcome, frontendBaseUrl)
          : undefined;
        const liveVerification = recordedPublicUrl
          ? await this.publicPageVerifier(recordedPublicUrl)
          : undefined;
        const notification = publicationOutcomeMessage(
          article,
          outcome,
          this.config.spreadsheetId,
          frontendBaseUrl,
          liveVerification,
        );
        const message = await this.bot.api.sendMessage(
          chatId,
          notification.text,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        await this.store.appendEvent({
          event_id: notificationEventId,
          article_id: article.article_id,
          event_type: "publication_notified",
          from_status: article.status,
          to_status: article.status,
          actor_type: "system",
          actor_id: "review-notifier",
          provider: "telegram",
          provider_object_id: String(message.message_id),
          message: `Publication outcome notification sent for ${outcomeEventId}`,
          payload_json: JSON.stringify({
            outcome_event_id: outcomeEventId,
            outcome_type: expectedEventType,
            public_url: notification.publicUrl ?? null,
          }),
          created_at: new Date().toISOString(),
        });
      } catch (error) {
        this.logger.error(
          { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
          "Publication outcome notification failed",
        );
      }
    }
  }
}

function numberSetting(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function publicationOutcomeMessage(
  article: SheetRecord,
  outcome: SheetRecord,
  spreadsheetId: string,
  frontendBaseUrl: string,
  liveVerification?: PublicPageVerification,
): { text: string; publicUrl?: string | undefined } {
  const sheetUrl = articleSheetUrl(spreadsheetId, article.__rowNumber);
  if (stringCell(outcome.event_type) === "published") {
    const payload = publicationEventPayload(outcome);
    const articleUrl = publicUrlForFrontend(stringCell(article.public_url), frontendBaseUrl);
    const publicUrl = trustedPublishedPublicUrl(article, outcome, frontendBaseUrl);
    if (publicUrl && liveVerification?.ok) {
      return {
        text: [
          `✅ <b>${escapeHtml(stringCell(article.article_id))} опубликована в Ghost.</b>`,
          `<a href="${escapeHtml(publicUrl)}">Открыть статью на сайте</a>`,
        ].join("\n"),
        publicUrl,
      };
    }
    const verificationMessage = publicUrl
      ? liveVerification?.message || payload.verificationMessage || stringCell(article.last_error)
      : payload.verificationOk
        ? "Публичный адрес не записан, не совпадает с таблицей или ведёт на неожиданный сайт."
        : payload.verificationMessage || stringCell(article.last_error);
    return {
      text: [
        `⚠️ <b>${escapeHtml(stringCell(article.article_id))} отправлена в Ghost, но публичная страница не прошла проверку.</b>`,
        verificationMessage
          ? `Причина: ${escapeHtml(verificationMessage)}`
          : "Публичный адрес не подтверждён или не совпадает с адресом в таблице.",
        articleUrl
          ? `<a href="${escapeHtml(articleUrl)}">Проверить публичную страницу</a>`
          : "",
        `<a href="${sheetUrl}">Проверить строку в Google Sheets</a>`,
      ].filter(Boolean).join("\n"),
      publicUrl: articleUrl,
    };
  }
  if (stringCell(outcome.event_type) === "publication_conflict") {
    return {
      text: [
        `⛔ <b>Публикация остановлена · ${escapeHtml(stringCell(article.article_id))}</b>`,
        "Текст изменился после согласования или состояние Ghost не совпало с таблицей. Статья не опубликована повторно.",
        "Исправьте конфликт в таблице и повторите публикацию после проверки.",
        `<a href="${sheetUrl}">Открыть статью в Google Sheets</a>`,
      ].join("\n"),
    };
  }
  return {
    text: [
      `⛔ <b>Ghost не опубликовал ${escapeHtml(stringCell(article.article_id))}</b>`,
      stringCell(article.last_error)
        ? `Причина: ${escapeHtml(stringCell(article.last_error))}`
        : "Причина записана в журнале событий.",
      "Исправьте причину в таблице или обратитесь к администратору, затем повторите публикацию.",
      `<a href="${sheetUrl}">Открыть статью в Google Sheets</a>`,
    ].join("\n"),
  };
}

function trustedPublishedPublicUrl(
  article: SheetRecord,
  outcome: SheetRecord,
  frontendBaseUrl: string,
): string | undefined {
  const payload = publicationEventPayload(outcome);
  if (!payload.verificationOk) return undefined;
  const articleUrl = publicUrlForFrontend(stringCell(article.public_url), frontendBaseUrl);
  const eventUrl = publicUrlForFrontend(payload.publicUrl ?? "", frontendBaseUrl);
  return articleUrl && eventUrl && articleUrl === eventUrl ? articleUrl : undefined;
}

function publicationEventPayload(event: SheetRecord): {
  publicUrl?: string | undefined;
  verificationOk: boolean;
  verificationMessage?: string | undefined;
} {
  try {
    const payload = JSON.parse(stringCell(event.payload_json)) as {
      public_url?: unknown;
      verification?: { ok?: unknown; message?: unknown };
    };
    return {
      publicUrl: typeof payload.public_url === "string" ? payload.public_url : undefined,
      verificationOk: payload.verification?.ok === true,
      verificationMessage:
        typeof payload.verification?.message === "string"
          ? payload.verification.message
          : undefined,
    };
  } catch {
    return { verificationOk: false };
  }
}

function publicUrlForFrontend(value: string, frontendBaseUrl: string): string | undefined {
  try {
    const parsed = new URL(value);
    const frontend = new URL(frontendBaseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (!["http:", "https:"].includes(frontend.protocol)) return undefined;
    return parsed.origin === frontend.origin ? parsed.toString() : undefined;
  } catch {
    return undefined;
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
