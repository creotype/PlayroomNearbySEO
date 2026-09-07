import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import {
  articleContentHash,
  booleanCell,
  dateCell,
  numberCell,
  stringCell,
  type Article,
  type CellValue,
  type SheetRecord,
} from "../domain/article.js";
import { assertTransition } from "../domain/transitions.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { SeoBot } from "../telegram/bot.js";
import { articleSheetUrl, escapeHtml, keywordSheetUrl } from "../telegram/messages.js";
import {
  latestEditorialSlot,
  nextPublicationAt,
  parseLocalClockTime,
  parseWeekdays,
  reviewStartedAt,
} from "./editorial-clock.js";
import type { GenerationService } from "./generation-service.js";
import type { QualityGate } from "./quality-gate.js";

const ACTIVE_REVIEW_STATUSES = ["needs_review", "failed_qa"] as const;

export type EditorialAutomationConfig = Pick<
  AppConfig,
  | "spreadsheetId"
  | "telegramReviewChatId"
  | "editorialAutomationEnabled"
  | "editorialTimeZone"
  | "editorialRunDays"
  | "editorialRunTime"
  | "autoPublishAfterReview"
  | "reviewDeadlineHours"
  | "publicationTime"
>;

export class EditorialAutomationService {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly generation: GenerationService,
    private readonly qualityGate: QualityGate,
    private readonly bot: SeoBot,
    private readonly config: EditorialAutomationConfig,
    private readonly logger: Logger,
    private readonly mutex: KeyedMutex,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<void> {
    if (!this.config.editorialAutomationEnabled) return;
    const settings = await this.store.getSettings();
    if (settings.has("editorial_automation_enabled") && !booleanCell(settings.get("editorial_automation_enabled"))) {
      return;
    }
    const timeZone = stringCell(settings.get("timezone")) || this.config.editorialTimeZone || "Europe/Belgrade";
    const chatId = reviewChatId(this.config.telegramReviewChatId, settings.get("telegram_chat_id"));

    if (this.#autoPublishingEnabled(settings)) {
      await this.#processOverdueReview(settings, timeZone, chatId);
    }
    await this.#processEditorialSlot(settings, timeZone, chatId);
  }

  #autoPublishingEnabled(settings: Map<string, CellValue>): boolean {
    if (this.config.autoPublishAfterReview === false) return false;
    if (settings.has("auto_publish_after_review")) {
      return booleanCell(settings.get("auto_publish_after_review"));
    }
    if (settings.has("auto_publish_without_approval")) {
      return booleanCell(settings.get("auto_publish_without_approval"));
    }
    return true;
  }

  async #processOverdueReview(
    settings: Map<string, CellValue>,
    timeZone: string,
    chatId: number | undefined,
  ): Promise<void> {
    const reviews = (await this.store.listArticles(["needs_review"]))
      .sort((left, right) => left.__rowNumber - right.__rowNumber);
    const review = reviews[0];
    if (!review) return;

    await this.mutex.runExclusive(review.article_id, async () => {
      const article = await this.store.findArticle(review.article_id);
      if (!article || article.status !== "needs_review") return;
      const currentHash = articleContentHash(article);
      if (stringCell(article.content_hash) !== currentHash) return;

      const events = await this.store.listEvents(article.article_id);
      const blocked = events.find(
        (event) =>
          stringCell(event.event_type) === "auto_approval_blocked" &&
          eventHash(event) === currentHash,
      );
      if (blocked) {
        await this.#notifyAutoApprovalBlocked(article, blocked, events, chatId);
        return;
      }

      const startedAt = reviewStartedAt(article.telegram_message_id, article.updated_at, timeZone);
      if (!startedAt) return;
      const ttlHours = positiveSettingNumber(
        settings.get("review_deadline_hours") ?? settings.get("review_window_hours"),
        this.config.reviewDeadlineHours ?? 48,
      );
      const deadline = new Date(startedAt.getTime() + ttlHours * 3_600_000);
      const now = this.clock();
      if (now.getTime() < deadline.getTime()) return;

      const quality = await this.qualityGate.evaluate(article);
      if (!quality.passed) {
        const blockedAt = now.toISOString();
        const event = {
          event_id: stableEventId("auto-approval-blocked", `${article.article_id}:${currentHash}`),
          article_id: article.article_id,
          event_type: "auto_approval_blocked",
          from_status: article.status,
          to_status: article.status,
          actor_type: "system",
          actor_id: "auto-review-timeout",
          provider: "system",
          provider_object_id: `review-timeout:${currentHash}`,
          message: "Automatic approval blocked by QA",
          payload_json: JSON.stringify({
            hash: currentHash,
            blockers: quality.blockers,
            score: quality.score,
            review_ttl_hours: ttlHours,
            review_started_at: startedAt.toISOString(),
            review_deadline_at: deadline.toISOString(),
          }),
          created_at: blockedAt,
        };
        const updated = await this.store.patchArticleAndAppendEvent(
          article.article_id,
          {
            qa_status: "fail",
            qa_blockers: quality.blockers.join(","),
            manual_required: true,
            updated_at: blockedAt,
          },
          event,
        );
        const recordedEvent = { __rowNumber: -1, ...event } as SheetRecord;
        await this.#notifyAutoApprovalBlocked(
          updated,
          recordedEvent,
          [...events, recordedEvent],
          chatId,
          ttlHours,
        );
        return;
      }

      const publicationTime = parseLocalClockTime(
        settings.get("publication_time"),
        this.config.publicationTime ?? "10:00",
      );
      // If the process was down past the originally eligible 10:00, never hand
      // the publisher a timestamp in the past: wait for the next real 10:00.
      const publicationNotBefore = new Date(Math.max(deadline.getTime(), now.getTime()));
      const publishAt = nextPublicationAt(publicationNotBefore, timeZone, publicationTime);
      const candidate = {
        ...article,
        scheduled_publish_at: publishAt.toISOString(),
      } as Article;
      const approvedHash = articleContentHash(candidate);
      assertTransition(article.status, "approved");
      const approvedAt = now.toISOString();
      await this.store.patchArticleAndAppendEvent(
        article.article_id,
        {
          status: "approved",
          scheduled_publish_at: publishAt.toISOString(),
          qa_status: "pass",
          qa_blockers: "",
          manual_required: false,
          content_hash: approvedHash,
          approved_by: "system:auto-review-timeout",
          approved_at: approvedAt,
          last_error: "",
          updated_at: approvedAt,
        },
        {
          event_id: stableEventId("auto-approved", `${article.article_id}:${currentHash}`),
          article_id: article.article_id,
          event_type: "approved",
          from_status: article.status,
          to_status: "approved",
          actor_type: "system",
          actor_id: "auto-review-timeout",
          provider: "system",
          provider_object_id: `review-timeout:${currentHash}`,
          message: `Automatically approved after ${ttlHours} review hours`,
          payload_json: JSON.stringify({
            hash: approvedHash,
            previous_hash: currentHash,
            review_started_at: startedAt.toISOString(),
            review_deadline_at: deadline.toISOString(),
            scheduled_publish_at: publishAt.toISOString(),
          }),
          created_at: approvedAt,
        },
      );
      if (chatId) {
        try {
          await this.bot.api.sendMessage(
            chatId,
            [
              `⏰ <b>${escapeHtml(article.article_id)} автоматически согласована.</b>`,
              `${ttlHours}-часовое окно проверки истекло. Публикация запланирована на ${escapeHtml(formatLocal(publishAt, timeZone))}.`,
              `<a href="${articleSheetUrl(this.config.spreadsheetId, article.__rowNumber)}">Открыть статью в Google Sheets</a>`,
            ].join("\n"),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          );
        } catch (error) {
          this.logger.error(
            { articleId: article.article_id, err: errorMessage(error) },
            "Automatic approval notification failed",
          );
        }
      }
    });
  }

  async #notifyAutoApprovalBlocked(
    article: Article,
    blocked: SheetRecord,
    events: readonly SheetRecord[],
    chatId: number | undefined,
    knownTtlHours?: number,
  ): Promise<void> {
    if (!chatId) return;
    const notificationId = stableEventId("auto-approval-blocked-notified", stringCell(blocked.event_id));
    if (events.some((event) => stringCell(event.event_id) === notificationId)) return;
    const ttlHours = knownTtlHours ?? numberPayloadField(blocked, "review_ttl_hours") ?? this.config.reviewDeadlineHours;
    try {
      const message = await this.bot.api.sendMessage(
        chatId,
        [
          `⛔ <b>${escapeHtml(article.article_id)} не опубликована автоматически.</b>`,
          `После ${ttlHours} часов финальная внутренняя проверка всё ещё требует правок. Технические детали записаны в таблице.`,
          "Исправьте статью в таблице и отправьте /regenerate с комментарием либо /approve после исправления.",
          `<a href="${articleSheetUrl(this.config.spreadsheetId, article.__rowNumber)}">Открыть статью в Google Sheets</a>`,
        ].join("\n"),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      await this.store.appendEvent({
        event_id: notificationId,
        article_id: article.article_id,
        event_type: "auto_approval_blocked_notified",
        from_status: article.status,
        to_status: article.status,
        actor_type: "system",
        actor_id: "editorial-automation",
        provider: "telegram",
        provider_object_id: String(message.message_id),
        message: "Automatic approval blocker sent to review chat",
        payload_json: JSON.stringify({ blocked_event_id: stringCell(blocked.event_id) }),
        created_at: this.clock().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        { articleId: article.article_id, err: errorMessage(error) },
        "Automatic approval blocker notification failed",
      );
    }
  }

  async #processEditorialSlot(
    settings: Map<string, CellValue>,
    timeZone: string,
    chatId: number | undefined,
  ): Promise<void> {
    if (!booleanCell(settings.get("generation_enabled"))) return;
    const weekdays = parseWeekdays(settings.get("editorial_run_days"), this.config.editorialRunDays ?? [1, 5]);
    const runTime = parseLocalClockTime(settings.get("editorial_run_time"), this.config.editorialRunTime ?? "10:00");
    const now = this.clock();
    const slot = latestEditorialSlot(now, timeZone, weekdays, runTime);
    if (!slot) return;
    const existingSlotEvents = await this.store.listEvents(slot.key);
    if (existingSlotEvents.some((event) => isTerminalSlotEvent(stringCell(event.event_type)))) return;

    const startedEvent = existingSlotEvents.find(
      (event) => stringCell(event.event_type) === "editorial_slot_started",
    );
    let candidate = startedEvent
      ? await this.store.findKeyword(stringPayloadField(startedEvent, "keyword_id"))
      : undefined;
    if (startedEvent && !candidate) {
      this.logger.error({ slot: slot.key }, "Claimed editorial slot lost its keyword row; refusing a second claim");
      return;
    }

    if (candidate) {
      const reconciled = await this.#finishClaimedSlot(slot.key, slot.scheduledAt, candidate, chatId);
      if (reconciled) return;
    }

    // A slot remains pending while the sole review card is unresolved. This keeps
    // the single-active invariant and catches the slot up as soon as that card closes.
    const activeReviews = await this.store.listArticles([...ACTIVE_REVIEW_STATUSES]);
    const candidateArticleId = stringCell(candidate?.article_id);
    const activeBelongsToClaim = candidateArticleId && activeReviews.some(
      (article) => article.article_id.toLowerCase() === candidateArticleId.toLowerCase(),
    );
    if (activeReviews.length > 0 && !activeBelongsToClaim) return;

    if (!candidate) {
      const candidates = await this.#scheduledCandidates(timeZone, now);
      candidate = candidates[0];
    }
    if (!candidate) {
      if (!chatId) return;
      try {
        const message = await this.bot.api.sendMessage(
          chatId,
          [
            "⚠️ <b>Нет доступных тем для плановой SEO-статьи.</b>",
            "Добавьте тему или ключевик в лист keywords и установите <code>status=ready</code>.",
            `<a href="${keywordSheetUrl(this.config.spreadsheetId)}">Открыть очередь в Google Sheets</a>`,
          ].join("\n"),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        await this.#appendSlotEvent(slot.key, "editorial_slot_no_source_notified", slot.scheduledAt, {
          provider: "telegram",
          providerObjectId: String(message.message_id),
          message: "No eligible keyword was available for the editorial slot",
        });
      } catch (error) {
        this.logger.error({ slot: slot.key, err: errorMessage(error) }, "Empty editorial queue notification failed");
      }
      return;
    }

    if (!startedEvent) {
      await this.#appendSlotEvent(slot.key, "editorial_slot_started", slot.scheduledAt, {
        message: `Claimed ${stringCell(candidate.keyword_id)} for the editorial slot`,
        payload: { keyword_id: stringCell(candidate.keyword_id), row_number: candidate.__rowNumber },
        terminal: false,
      });
    }

    await this.generation.runOnce(stringCell(candidate.keyword_id));
    const refreshed = await this.store.findKeyword(stringCell(candidate.keyword_id)) ?? candidate;
    await this.#finishClaimedSlot(slot.key, slot.scheduledAt, refreshed, chatId);
  }

  async #finishClaimedSlot(
    slotKey: string,
    scheduledAt: Date,
    candidate: SheetRecord,
    chatId: number | undefined,
  ): Promise<boolean> {
    const status = stringCell(candidate.status);
    const articleId = stringCell(candidate.article_id);
    if (status === "used" && articleId && await this.store.findArticle(articleId)) {
      await this.#appendSlotEvent(slotKey, "editorial_slot_generated", scheduledAt, {
        message: `Generated ${articleId} from ${stringCell(candidate.keyword_id)}`,
        payload: { article_id: articleId, keyword_id: stringCell(candidate.keyword_id) },
      });
      return true;
    }
    if (status === "paused") {
      if (chatId) {
        try {
          await this.bot.api.sendMessage(
            chatId,
            [
              `⛔ <b>Не удалось сгенерировать плановую статью.</b>`,
              `Проверьте ключевик ${escapeHtml(stringCell(candidate.keyword_id))} и журнал ошибки в таблице. Автоматического платного повтора не будет.`,
              `<a href="${keywordSheetUrl(this.config.spreadsheetId, candidate.__rowNumber)}">Открыть ключевик в Google Sheets</a>`,
            ].join("\n"),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          );
        } catch (error) {
          this.logger.error({ slot: slotKey, err: errorMessage(error) }, "Scheduled generation failure notification failed");
        }
      }
      await this.#appendSlotEvent(slotKey, "editorial_slot_generation_failed", scheduledAt, {
        message: `Generation failed for ${stringCell(candidate.keyword_id)}`,
        payload: { article_id: articleId || null, keyword_id: stringCell(candidate.keyword_id) },
      });
      return true;
    }
    return false;
  }

  async #scheduledCandidates(timeZone: string, now: Date): Promise<SheetRecord[]> {
    const rows = await this.store.listKeywords(["ready", "assigned", "generating"]);
    const candidates: SheetRecord[] = [];
    for (const row of rows) {
      const status = stringCell(row.status);
      if (["assigned", "generating"].includes(status)) {
        const articleId = stringCell(row.article_id);
        if (!articleId) continue;
        const events = await this.store.listEvents(articleId);
        const isManual = events.some(
          (event) =>
            stringCell(event.event_type) === "generation_requested" &&
            stringCell(event.provider) === "telegram",
        );
        if (isManual) continue;
      }
      const planned = row.planned_publish_at;
      if (planned !== undefined && planned !== null && planned !== "") {
        const due = dateCell(planned, timeZone);
        if (!due || due.getTime() > now.getTime()) continue;
      }
      candidates.push(row);
    }
    return candidates.sort((left, right) => {
      const recoveryOrder =
        Number(["assigned", "generating"].includes(stringCell(right.status))) -
        Number(["assigned", "generating"].includes(stringCell(left.status)));
      if (recoveryOrder) return recoveryOrder;
      const priority = numberCell(right.priority) - numberCell(left.priority);
      return priority || left.__rowNumber - right.__rowNumber;
    });
  }

  async #appendSlotEvent(
    slotKey: string,
    eventType: string,
    scheduledAt: Date,
    options: {
      provider?: string;
      providerObjectId?: string;
      message: string;
      payload?: Record<string, unknown>;
      terminal?: boolean;
    },
  ): Promise<void> {
    await this.store.appendEvent({
      event_id: stableEventId(eventType, slotKey),
      article_id: slotKey,
      event_type: eventType,
      from_status: "scheduled",
      to_status: options.terminal === false ? "claimed" : "completed",
      actor_type: "system",
      actor_id: "editorial-automation",
      provider: options.provider ?? "system",
      provider_object_id: options.providerObjectId ?? slotKey,
      message: options.message,
      payload_json: JSON.stringify({
        scheduled_at: scheduledAt.toISOString(),
        ...(options.payload ?? {}),
      }),
      created_at: this.clock().toISOString(),
    });
  }
}

function reviewChatId(configured: number | undefined, sheetValue: CellValue | undefined): number | undefined {
  if (configured) return configured;
  const parsed = Number(sheetValue);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : undefined;
}

function positiveSettingNumber(value: CellValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventHash(event: SheetRecord): string | undefined {
  try {
    const payload = JSON.parse(stringCell(event.payload_json)) as { hash?: unknown };
    return typeof payload.hash === "string" ? payload.hash : undefined;
  } catch {
    return undefined;
  }
}

function stringPayloadField(event: SheetRecord, field: string): string {
  try {
    const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
    return typeof payload[field] === "string" ? String(payload[field]).trim() : "";
  } catch {
    return "";
  }
}

function numberPayloadField(event: SheetRecord, field: string): number | undefined {
  try {
    const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
    const value = Number(payload[field]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function stableEventId(kind: string, source: string): string {
  const hash = createHash("sha256").update(`${kind}:${source}`).digest("hex").slice(0, 24);
  return `evt-${kind}-${hash}`;
}

function isTerminalSlotEvent(eventType: string): boolean {
  return [
    "editorial_slot_generated",
    "editorial_slot_no_source_notified",
    "editorial_slot_generation_failed",
  ].includes(eventType);
}

function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
