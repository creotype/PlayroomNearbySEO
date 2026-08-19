import { randomUUID } from "node:crypto";
import type { Article } from "../domain/article.js";
import { articleContentHash, stringCell } from "../domain/article.js";
import { assertTransition } from "../domain/transitions.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { QualityGate, QualityResult } from "./quality-gate.js";

export type TelegramActor = {
  id: number;
  username?: string;
  displayName: string;
  providerObjectId: string;
};

export type ApprovalResult =
  | { outcome: "approved"; article: Article }
  | { outcome: "already_approved"; article: Article }
  | { outcome: "blocked"; article: Article; quality: QualityResult }
  | { outcome: "invalid_status"; article: Article };

export class ApprovalService {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly qualityGate: QualityGate,
    private readonly mutex: KeyedMutex,
  ) {}

  async approve(articleId: string, actor: TelegramActor): Promise<ApprovalResult> {
    return this.mutex.runExclusive(articleId, async () => {
      const article = await this.#requiredArticle(articleId);
      const commandId = telegramCommandId(actor.providerObjectId);
      const events = await this.store.listEvents(article.article_id);
      const duplicateEvent = events.find(
        (event) => stringCell(event.provider_object_id) === commandId,
      );
      if (duplicateEvent && stringCell(duplicateEvent.event_type) === "approved") {
        return { outcome: "already_approved", article };
      }
      if (duplicateEvent && stringCell(duplicateEvent.event_type) === "approval_blocked") {
        return { outcome: "blocked", article, quality: await this.qualityGate.evaluate(article) };
      }

      const currentHash = articleContentHash(article);
      const matchingApproval = events.some((event) => {
        if (stringCell(event.event_type) !== "approved") return false;
        return readEventHash(stringCell(event.payload_json)) === currentHash;
      });
      if (["approved", "scheduled", "publishing", "published"].includes(article.status) && matchingApproval) {
        return { outcome: "already_approved", article };
      }
      if (article.status !== "needs_review") return { outcome: "invalid_status", article };

      const quality = await this.qualityGate.evaluate(article);
      if (!quality.passed) {
        const now = new Date().toISOString();
        const updated = await this.store.patchArticleAndAppendEvent(article.article_id, {
          qa_status: "failed",
          qa_blockers: quality.blockers.join(","),
          updated_at: now,
        }, {
          event_id: randomUUID(),
          article_id: article.article_id,
          event_type: "approval_blocked",
          from_status: article.status,
          to_status: article.status,
          actor_type: "telegram_user",
          actor_id: String(actor.id),
          provider: "telegram",
          provider_object_id: commandId,
          message: "Approval blocked by QA",
          payload_json: JSON.stringify({ blockers: quality.blockers, score: quality.score }),
          created_at: now,
        });
        return { outcome: "blocked", article: updated, quality };
      }

      assertTransition(article.status, "approved");
      const now = new Date().toISOString();
      const approvalEvent = {
        event_id: randomUUID(),
        article_id: article.article_id,
        event_type: "approved",
        from_status: article.status,
        to_status: "approved",
        actor_type: "telegram_user",
        actor_id: String(actor.id),
        provider: "telegram",
        provider_object_id: commandId,
        message: `Approved by ${actor.displayName}`,
        payload_json: JSON.stringify({
          hash: currentHash,
          username: actor.username ?? null,
          display_name: actor.displayName,
        }),
        created_at: now,
      };
      const updated = await this.store.patchArticleAndAppendEvent(
        article.article_id,
        {
          status: "approved",
          content_hash: currentHash,
          approved_by: `telegram:${actor.id}`,
          approved_at: now,
          last_error: "",
          updated_at: now,
        },
        approvalEvent,
      );
      return { outcome: "approved", article: updated };
    });
  }

  async cancel(articleId: string, reason: string, actor: TelegramActor): Promise<Article> {
    return this.mutex.runExclusive(articleId, async () => {
      const article = await this.#requiredArticle(articleId);
      const commandId = telegramCommandId(actor.providerObjectId);
      const duplicate = (await this.store.listEvents(article.article_id)).some(
        (event) =>
          stringCell(event.event_type) === "cancelled" &&
          stringCell(event.provider_object_id) === commandId,
      );
      if (duplicate) return article;
      if (article.status === "published") throw new Error("Published articles cannot be cancelled");
      if (article.status !== "cancelled") assertTransition(article.status, "cancelled");
      const now = new Date().toISOString();
      return this.store.patchArticleAndAppendEvent(article.article_id, {
        status: "cancelled",
        feedback: reason,
        updated_at: now,
      }, {
        event_id: randomUUID(),
        article_id: article.article_id,
        event_type: "cancelled",
        from_status: article.status,
        to_status: "cancelled",
        actor_type: "telegram_user",
        actor_id: String(actor.id),
        provider: "telegram",
        provider_object_id: commandId,
        message: reason,
        payload_json: JSON.stringify({ username: actor.username ?? null }),
        created_at: now,
      });
    });
  }

  async #requiredArticle(articleId: string): Promise<Article> {
    const article = await this.store.findArticle(articleId);
    if (!article) throw new Error(`Article not found: ${articleId}`);
    return article;
  }
}

function telegramCommandId(providerObjectId: string): string {
  return `telegram:${providerObjectId}`;
}

function readEventHash(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : undefined;
  } catch {
    return undefined;
  }
}
