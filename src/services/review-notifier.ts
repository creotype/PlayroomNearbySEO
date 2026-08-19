import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { articleContentHash, stringCell } from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { SeoBot } from "../telegram/bot.js";
import { reviewKeyboard } from "../telegram/bot.js";
import { articleCard } from "../telegram/messages.js";

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
            { parse_mode: "HTML", reply_markup: reviewKeyboard(article.article_id), link_preview_options: { is_disabled: true } },
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
          { parse_mode: "HTML", reply_markup: reviewKeyboard(article.article_id), link_preview_options: { is_disabled: true } },
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
  }
}
