import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import {
  articleContentHash,
  booleanCell,
  numberCell,
  stringCell,
  type Article,
  type CellValue,
  type SheetRecord,
} from "../domain/article.js";
import {
  GENERATED_QA_BLOCKER_CODES,
  isSemanticGeneratedQaBlocker,
  type GeneratedQaBlockerCode,
} from "../domain/quality.js";
import type { AuditEvent, GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { SeoBot } from "../telegram/bot.js";
import { articleSheetUrl, escapeHtml } from "../telegram/messages.js";
import type { GenerationService, RegenerationResult } from "./generation-service.js";

const ACTOR_ID = "auto-qa-repair";
const MAX_ATTEMPTS = 1;
const REPAIRABLE_STATUSES = ["needs_review", "failed_qa"] as const;
const TERMINAL_EVENT_TYPES = new Set([
  "auto_qa_repair_completed",
  "auto_qa_repair_exhausted",
  "auto_qa_repair_superseded",
]);

type Delivery = {
  delivered: boolean;
  messageId?: number;
};

type RepairIdentity = {
  articleId: string;
  inputHash: string;
  source: string;
  providerObjectId: string;
  progressEventId: string;
  startedEventId: string;
};

type InterruptedRecovery = {
  started: SheetRecord;
  terminal?: SheetRecord;
};

/**
 * Performs at most one paid system revision for each publishable article hash.
 *
 * The outer started event is committed before the GenerationService paid-attempt
 * ledger. A restart may safely resume while that inner ledger is absent. Once the
 * inner ledger exists, the paid result is ambiguous and must never be replayed.
 */
export class AutoQaRepairService {
  #activeRun: Promise<void> | undefined;

  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly generation: GenerationService,
    private readonly bot: SeoBot,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  runOnce(): Promise<void> {
    if (this.#activeRun) return this.#activeRun;
    const run = this.#run();
    this.#activeRun = run;
    return run.finally(() => {
      if (this.#activeRun === run) this.#activeRun = undefined;
    });
  }

  async #run(): Promise<void> {
    const settings = await this.store.getSettings();
    const configuredChatId = Number(settings.get("telegram_chat_id"));
    const chatId = this.config.telegramReviewChatId ?? (
      Number.isSafeInteger(configuredChatId) ? configuredChatId : undefined
    );
    const candidates = (await this.store.listArticles([...REPAIRABLE_STATUSES]))
      .sort((left, right) => left.__rowNumber - right.__rowNumber);

    for (const candidate of candidates) {
      try {
        await this.#processArticle(candidate.article_id, chatId);
      } catch (error) {
        this.logger.error(
          {
            articleId: candidate.article_id,
            err: error instanceof Error ? error.message : String(error),
          },
          "Automatic QA repair failed",
        );
      }
    }
  }

  async #processArticle(articleId: string, chatId: number | undefined): Promise<void> {
    let article = await this.store.findArticle(articleId);
    if (!isActiveRepairArticle(article)) return;

    let events = await this.store.listEvents(articleId);
    const currentHash = articleContentHash(article);
    const committedStart = committedRegenerationStart(events, article);
    if (committedStart) {
      await this.#recoverUnfinished(
        article,
        { started: committedStart },
        events,
        chatId,
      );
      return;
    }
    const existingTerminal = terminalForHash(events, currentHash);
    if (existingTerminal) {
      const recovery = interruptedRecovery(existingTerminal, events, article, currentHash);
      if (recovery) {
        await this.#recoverUnfinished(article, recovery, events, chatId);
      } else if (stringCell(existingTerminal.event_type) === "auto_qa_repair_exhausted") {
        await this.#notifyExhausted(article, existingTerminal, events, chatId);
      }
      return;
    }

    const unfinishedStart = [...events]
      .reverse()
      .find((event) =>
        stringCell(event.event_type) === "auto_qa_repair_started" &&
        !terminalForStartedEvent(events, stringCell(event.event_id)) &&
        unfinishedStartApplies(event, events, article!, currentHash),
      );
    if (unfinishedStart) {
      await this.#recoverUnfinished(
        article,
        {
          started: unfinishedStart,
        },
        events,
        chatId,
      );
      return;
    }
    if (!isRepairCandidate(article)) return;

    const identity = repairIdentity(article.article_id, currentHash);
    const progress = events.some((event) => stringCell(event.event_id) === identity.progressEventId)
      ? existingMessage(article)
      : await this.#recordProgress(article, identity, chatId);

    article = await this.store.findArticle(articleId);
    if (!isRepairCandidate(article) || articleContentHash(article) !== currentHash) return;
    events = await this.store.listEvents(articleId);
    if (events.some((event) => stringCell(event.event_id) === identity.startedEventId)) {
      const started = events.find((event) => stringCell(event.event_id) === identity.startedEventId)!;
      await this.#recoverUnfinished(
        article,
        { started },
        events,
        chatId,
      );
      return;
    }

    const startedAt = new Date().toISOString();
    const started = await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        // Do not mutate editorial state before the paid call. A concurrent human
        // regeneration may already hold the shared article lock; the expected
        // hash below is what authorizes this automatic attempt.
        ...(progress.messageId ? { telegram_message_id: progress.messageId } : {}),
        updated_at: startedAt,
      },
      {
        event_id: identity.startedEventId,
        article_id: article.article_id,
        event_type: "auto_qa_repair_started",
        from_status: article.status,
        to_status: article.status,
        actor_type: "system",
        actor_id: ACTOR_ID,
        provider: "openai",
        provider_object_id: identity.providerObjectId,
        message: "Automatic QA repair attempt started",
        payload_json: JSON.stringify({
          hash: identity.inputHash,
          input_hash: identity.inputHash,
          attempt: 1,
          max_attempts: MAX_ATTEMPTS,
          progress_event_id: identity.progressEventId,
          manual_required_before_attempt: booleanCell(article.manual_required),
        }),
        created_at: startedAt,
      },
    );

    await this.#executeAttempt(started, identity, events, chatId, false);
  }

  async #executeAttempt(
    started: Article,
    identity: RepairIdentity,
    events: SheetRecord[],
    chatId: number | undefined,
    recoverSystemManualGate: boolean,
  ): Promise<void> {
    let article: Article | undefined = started;

    let result: RegenerationResult | undefined;
    let failure: unknown;
    try {
      result = await this.generation.regenerateArticle({
        articleId: started.article_id,
        feedback: "Fix every current QA defect and return a complete, publication-safe article.",
        actorId: ACTOR_ID,
        actorName: ACTOR_ID,
        providerObjectId: identity.providerObjectId,
        actorType: "system",
        provider: "system",
        expectedContentHash: identity.inputHash,
        requireQaFailure: true,
        expectedManualRequired: booleanCell(started.manual_required),
        expectedQaBlockers: stringCell(started.qa_blockers),
        ...(recoverSystemManualGate ? { recoverSystemManualGate: true } : {}),
      });
    } catch (error) {
      failure = error;
    }

    // A Sheets write can commit and still surface as an upstream error. Re-read
    // both the article and audit log before deciding whether the attempt failed.
    article = await this.store.findArticle(started.article_id);
    if (!article) return;
    events = await this.store.listEvents(started.article_id);
    const regenerated = matchingRegeneratedEvent(events, identity.providerObjectId);
    if (result?.outcome === "regenerated" || result?.outcome === "already_regenerated" || regenerated) {
      await this.#finishAttempt(
        result && "article" in result ? result.article : article,
        identity,
        events,
        chatId,
        result?.outcome ?? "recovered_regenerated",
      );
      return;
    }

    const paidAttempt = matchingRegenerationAttemptEvent(events, identity.providerObjectId);
    if (failure && !paidAttempt) {
      // The failure happened before GenerationService's durable paid-attempt
      // ledger. It is safe to leave the outer attempt pending for the next tick.
      this.logger.warn(
        { articleId: article.article_id },
        "Automatic QA repair paused before the paid attempt",
      );
      return;
    }

    if (
      result?.outcome === "blocked" &&
      ["stale_article", "invalid_status"].includes(result.reason)
    ) {
      await this.#finishSuperseded(article, identity, events, result.reason);
      return;
    }

    const reason = result?.outcome === "blocked"
      ? `blocked:${result.reason}`
      : failure instanceof Error
        ? `error:${failure.message}`
        : `error:${String(failure ?? "unknown")}`;
    await this.#finishExhausted(article, identity, events, chatId, reason);
  }

  async #recordProgress(
    article: Article,
    identity: RepairIdentity,
    chatId: number | undefined,
  ): Promise<Delivery> {
    const delivery = await this.#deliverProgress(article, chatId);
    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        ...(delivery.messageId ? { telegram_message_id: delivery.messageId } : {}),
        updated_at: now,
      },
      {
        event_id: identity.progressEventId,
        article_id: article.article_id,
        event_type: "auto_qa_repair_progress",
        from_status: article.status,
        to_status: article.status,
        actor_type: "system",
        actor_id: ACTOR_ID,
        provider: delivery.delivered ? "telegram" : "system",
        ...(delivery.messageId ? { provider_object_id: String(delivery.messageId) } : {}),
        message: delivery.delivered
          ? "Automatic QA repair progress shown"
          : "Automatic QA repair progress could not be shown",
        payload_json: JSON.stringify({
          hash: identity.inputHash,
          input_hash: identity.inputHash,
          attempt: 1,
          max_attempts: MAX_ATTEMPTS,
          delivered: delivery.delivered,
          message_id: delivery.messageId ?? null,
        }),
        created_at: now,
      },
    );
    return delivery;
  }

  async #deliverProgress(article: Article, chatId: number | undefined): Promise<Delivery> {
    const messageId = existingMessage(article).messageId;
    if (chatId === undefined) return { delivered: false, ...(messageId ? { messageId } : {}) };
    const text = progressMessage();

    if (messageId) {
      try {
        await this.bot.api.editMessageText(chatId, messageId, text, telegramOptions());
        return { delivered: true, messageId };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/message is not modified/iu.test(detail)) return { delivered: true, messageId };
        if (!/message to edit not found/iu.test(detail)) {
          this.logger.warn({ articleId: article.article_id, err: detail }, "QA repair progress notification failed");
          return { delivered: false, messageId };
        }
      }
    }

    try {
      const message = await this.bot.api.sendMessage(chatId, text, telegramOptions());
      return { delivered: true, messageId: message.message_id };
    } catch (error) {
      this.logger.warn(
        { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
        "QA repair progress notification failed",
      );
      return { delivered: false, ...(messageId ? { messageId } : {}) };
    }
  }

  async #recoverUnfinished(
    article: Article,
    recovery: InterruptedRecovery,
    events: SheetRecord[],
    chatId: number | undefined,
  ): Promise<void> {
    const { started } = recovery;
    const identity = identityFromStarted(article.article_id, started);
    const regenerated = matchingRegeneratedEvent(events, identity.providerObjectId);
    if (regenerated && regeneratedMatchesArticle(regenerated, article)) {
      await this.#finishAttempt(article, identity, events, chatId, "recovered_regenerated");
      return;
    }
    if (identity.inputHash !== articleContentHash(article)) {
      await this.#finishSuperseded(article, identity, events, "newer_article_revision");
      return;
    }
    if (matchingRegenerationAttemptEvent(events, identity.providerObjectId)) {
      await this.#finishExhausted(
        article,
        identity,
        events,
        chatId,
        "interrupted_after_attempt_started",
      );
      return;
    }
    if (hasHumanActivityAfter(events, started)) {
      await this.#finishSuperseded(article, identity, events, "human_activity");
      return;
    }

    await this.#recordRecoveryProgress(article, identity, recovery.terminal, events, chatId);

    const latest = await this.store.findArticle(article.article_id);
    if (!isRepairCandidate(latest) || articleContentHash(latest) !== identity.inputHash) {
      if (latest) {
        const freshEvents = await this.store.listEvents(article.article_id);
        await this.#finishSuperseded(latest, identity, freshEvents, "newer_article_revision");
      }
      return;
    }
    const freshEvents = await this.store.listEvents(article.article_id);
    if (hasHumanActivityAfter(freshEvents, started)) {
      await this.#finishSuperseded(latest, identity, freshEvents, "human_activity");
      return;
    }
    if (matchingRegenerationAttemptEvent(freshEvents, identity.providerObjectId)) {
      await this.#finishExhausted(
        latest,
        identity,
        freshEvents,
        chatId,
        "interrupted_after_attempt_started",
      );
      return;
    }

    const liveTerminal = recovery.terminal
      ? freshEvents.find(
          (event) => stringCell(event.event_id) === stringCell(recovery.terminal?.event_id),
        )
      : undefined;
    const recoverSystemManualGate = Boolean(
      liveTerminal && systemCreatedManualGateCanBeRecovered(started, liveTerminal, latest),
    );

    await this.#executeAttempt(
      latest,
      identity,
      freshEvents,
      chatId,
      recoverSystemManualGate,
    );
  }

  async #recordRecoveryProgress(
    article: Article,
    identity: RepairIdentity,
    terminal: SheetRecord | undefined,
    events: SheetRecord[],
    chatId: number | undefined,
  ): Promise<void> {
    const source = `${identity.startedEventId}:${stringCell(terminal?.event_id) || "unfinished"}`;
    const eventId = stableEventId("auto-qa-repair-recovery-progress", source);
    if (events.some((event) => stringCell(event.event_id) === eventId)) return;

    const delivery = await this.#deliverProgress(article, chatId);
    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        ...(delivery.messageId ? { telegram_message_id: delivery.messageId } : {}),
        updated_at: now,
      },
      {
        event_id: eventId,
        article_id: article.article_id,
        event_type: "auto_qa_repair_recovery_progress",
        from_status: article.status,
        to_status: article.status,
        actor_type: "system",
        actor_id: ACTOR_ID,
        provider: delivery.delivered ? "telegram" : "system",
        ...(delivery.messageId ? { provider_object_id: String(delivery.messageId) } : {}),
        message: delivery.delivered
          ? "Automatic QA repair recovery progress shown"
          : "Automatic QA repair recovery progress could not be shown",
        payload_json: JSON.stringify({
          input_hash: identity.inputHash,
          started_event_id: identity.startedEventId,
          terminal_event_id: stringCell(terminal?.event_id) || null,
          delivered: delivery.delivered,
          message_id: delivery.messageId ?? null,
        }),
        created_at: now,
      },
    );
  }

  async #finishAttempt(
    article: Article,
    identity: RepairIdentity,
    events: SheetRecord[],
    chatId: number | undefined,
    generationOutcome: string,
  ): Promise<void> {
    const latest = await this.store.findArticle(article.article_id) ?? article;
    const passed = latest.status === "needs_review" &&
      stringCell(latest.qa_status) === "pass" &&
      !stringCell(latest.qa_blockers) &&
      !booleanCell(latest.manual_required);
    if (!passed) {
      await this.#finishExhausted(latest, identity, events, chatId, `qa_failed:${generationOutcome}`);
      return;
    }

    const terminalId = stableEventId("auto-qa-repair-completed", identity.startedEventId);
    if (events.some((event) => stringCell(event.event_id) === terminalId)) return;
    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      latest.article_id,
      {
        status: "needs_review",
        manual_required: false,
        updated_at: now,
      },
      terminalEvent({
        eventId: terminalId,
        eventType: "auto_qa_repair_completed",
        article: latest,
        identity,
        toStatus: "needs_review",
        outcome: "passed",
        detail: generationOutcome,
        createdAt: now,
      }),
    );
  }

  async #finishExhausted(
    article: Article,
    identity: RepairIdentity,
    events: SheetRecord[],
    chatId: number | undefined,
    reason: string,
  ): Promise<void> {
    let terminalId = stableEventId("auto-qa-repair-exhausted", identity.startedEventId);
    let terminal = events.find((event) => stringCell(event.event_id) === terminalId);
    if (
      terminal &&
      stringField(eventPayload(terminal), "detail") === "interrupted_after_attempt_started" &&
      reason !== "interrupted_after_attempt_started"
    ) {
      // The old terminal was a pre-paid false exhaustion. A later real attempt
      // needs its own terminal so both its output hash and final reason are closed.
      terminalId = stableEventId(
        "auto-qa-repair-exhausted",
        `${identity.startedEventId}:${articleContentHash(article)}:${reason}`,
      );
      terminal = events.find((event) => stringCell(event.event_id) === terminalId);
    }
    let failedArticle = await this.store.findArticle(article.article_id) ?? article;
    if (!terminal) {
      const now = new Date().toISOString();
      failedArticle = await this.store.patchArticleAndAppendEvent(
        failedArticle.article_id,
        {
          status: "failed_qa",
          qa_status: "fail",
          manual_required: true,
          updated_at: now,
        },
        terminalEvent({
          eventId: terminalId,
          eventType: "auto_qa_repair_exhausted",
          article: failedArticle,
          identity,
          toStatus: "failed_qa",
          outcome: "exhausted",
          detail: reason,
          createdAt: now,
        }),
      );
      terminal = {
        __rowNumber: 0,
        ...terminalEvent({
          eventId: terminalId,
          eventType: "auto_qa_repair_exhausted",
          article: failedArticle,
          identity,
          toStatus: "failed_qa",
          outcome: "exhausted",
          detail: reason,
          createdAt: now,
        }),
      } as SheetRecord;
      events = await this.store.listEvents(article.article_id);
    }
    await this.#notifyExhausted(failedArticle, terminal, events, chatId);
  }

  async #finishSuperseded(
    article: Article,
    identity: RepairIdentity,
    events: SheetRecord[],
    reason: string,
  ): Promise<void> {
    const terminalId = stableEventId("auto-qa-repair-superseded", identity.startedEventId);
    if (events.some((event) => stringCell(event.event_id) === terminalId)) return;
    const latest = await this.store.findArticle(article.article_id) ?? article;
    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      latest.article_id,
      {},
      {
        event_id: terminalId,
        article_id: latest.article_id,
        event_type: "auto_qa_repair_superseded",
        from_status: latest.status,
        to_status: latest.status,
        actor_type: "system",
        actor_id: ACTOR_ID,
        provider: "system",
        provider_object_id: identity.providerObjectId,
        message: "Automatic QA repair skipped because the article changed",
        payload_json: JSON.stringify({
          input_hash: identity.inputHash,
          outcome: "superseded",
          detail: reason,
          started_event_id: identity.startedEventId,
        }),
        created_at: now,
      },
    );
  }

  async #notifyExhausted(
    article: Article,
    terminal: SheetRecord,
    events: SheetRecord[],
    chatId: number | undefined,
  ): Promise<void> {
    const terminalId = stringCell(terminal.event_id);
    const startedEventId = stringField(eventPayload(terminal), "started_event_id");
    const recoveryProgress = [...events].reverse().find((event) =>
      stringCell(event.event_type) === "auto_qa_repair_recovery_progress" &&
      stringField(eventPayload(event), "started_event_id") === startedEventId,
    );
    const notificationId = stableEventId(
      "auto-qa-repair-notified",
      recoveryProgress
        ? `${terminalId}:${stringCell(recoveryProgress.event_id)}`
        : terminalId,
    );
    if (events.some((event) => stringCell(event.event_id) === notificationId) || chatId === undefined) return;

    const delivery = await this.#deliverExhausted(article, chatId);
    if (!delivery.delivered || !delivery.messageId) return;
    const freshEvents = await this.store.listEvents(article.article_id);
    if (freshEvents.some((event) => stringCell(event.event_id) === notificationId)) return;

    const now = new Date().toISOString();
    await this.store.patchArticleAndAppendEvent(
      article.article_id,
      {
        telegram_message_id: delivery.messageId,
        updated_at: now,
      },
      {
        event_id: notificationId,
        article_id: article.article_id,
        event_type: "auto_qa_repair_notified",
        from_status: "failed_qa",
        to_status: "failed_qa",
        actor_type: "system",
        actor_id: ACTOR_ID,
        provider: "telegram",
        provider_object_id: String(delivery.messageId),
        message: "Automatic QA repair exhaustion notice shown",
        payload_json: JSON.stringify({
          terminal_event_id: terminalId,
          message_id: delivery.messageId,
        }),
        created_at: now,
      },
    );
  }

  async #deliverExhausted(article: Article, chatId: number): Promise<Delivery> {
    const messageId = existingMessage(article).messageId;
    const text = exhaustedMessage(article, this.config.spreadsheetId);
    if (messageId) {
      try {
        await this.bot.api.editMessageText(chatId, messageId, text, telegramOptions());
        return { delivered: true, messageId };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/message is not modified/iu.test(detail)) return { delivered: true, messageId };
        if (!/message to edit not found/iu.test(detail)) {
          this.logger.warn({ articleId: article.article_id, err: detail }, "QA repair exhaustion notification failed");
          return { delivered: false, messageId };
        }
      }
    }

    try {
      const message = await this.bot.api.sendMessage(chatId, text, telegramOptions());
      return { delivered: true, messageId: message.message_id };
    } catch (error) {
      this.logger.warn(
        { articleId: article.article_id, err: error instanceof Error ? error.message : String(error) },
        "QA repair exhaustion notification failed",
      );
      return { delivered: false, ...(messageId ? { messageId } : {}) };
    }
  }
}

function isRepairCandidate(article: Article | undefined): article is Article {
  return Boolean(
    article &&
    REPAIRABLE_STATUSES.includes(article.status as (typeof REPAIRABLE_STATUSES)[number]) &&
    stringCell(article.qa_status) === "fail",
  );
}

function isActiveRepairArticle(article: Article | undefined): article is Article {
  return Boolean(
    article && REPAIRABLE_STATUSES.includes(article.status as (typeof REPAIRABLE_STATUSES)[number]),
  );
}

function existingMessage(article: Article): Delivery {
  const messageId = Number(article.telegram_message_id);
  return Number.isSafeInteger(messageId) && messageId > 0
    ? { delivered: true, messageId }
    : { delivered: false };
}

function repairIdentity(articleId: string, inputHash: string): RepairIdentity {
  const source = `${articleId}:${inputHash}:1`;
  const commandDigest = createHash("sha256").update(`auto-qa-repair:${source}`).digest("hex").slice(0, 24);
  return {
    articleId,
    inputHash,
    source,
    providerObjectId: `auto-qa-repair:${commandDigest}`,
    progressEventId: stableEventId("auto-qa-repair-progress", source),
    startedEventId: stableEventId("auto-qa-repair-started", source),
  };
}

function identityFromStarted(articleId: string, started: SheetRecord): RepairIdentity {
  const payload = eventPayload(started);
  const inputHash = stringField(payload, "input_hash") || stringField(payload, "hash");
  const fallback = repairIdentity(articleId, inputHash || "unknown");
  return {
    ...fallback,
    startedEventId: stringCell(started.event_id) || fallback.startedEventId,
    providerObjectId: stringCell(started.provider_object_id) || fallback.providerObjectId,
  };
}

function terminalForStartedEvent(events: SheetRecord[], startedEventId: string): SheetRecord | undefined {
  return events.find((event) =>
    TERMINAL_EVENT_TYPES.has(stringCell(event.event_type)) &&
    stringField(eventPayload(event), "started_event_id") === startedEventId,
  );
}

function committedRegenerationStart(
  events: SheetRecord[],
  article: Article,
): SheetRecord | undefined {
  return [...events].reverse().find((started) => {
    if (stringCell(started.event_type) !== "auto_qa_repair_started") return false;
    const identity = identityFromStarted(article.article_id, started);
    const regenerated = matchingRegeneratedEvent(events, identity.providerObjectId);
    if (!regenerated || !regeneratedMatchesArticle(regenerated, article)) return false;

    const terminals = events.filter((event) =>
      TERMINAL_EVENT_TYPES.has(stringCell(event.event_type)) &&
      stringField(eventPayload(event), "started_event_id") === stringCell(started.event_id),
    );
    return terminals.every((terminal) =>
      stringCell(terminal.event_type) === "auto_qa_repair_exhausted" &&
      stringField(eventPayload(terminal), "detail") === "interrupted_after_attempt_started",
    );
  });
}

function unfinishedStartApplies(
  started: SheetRecord,
  events: SheetRecord[],
  article: Article,
  currentHash: string,
): boolean {
  const identity = identityFromStarted(article.article_id, started);
  if (identity.inputHash === currentHash) return true;
  const regenerated = matchingRegeneratedEvent(events, identity.providerObjectId);
  if (!regenerated) return false;
  return regeneratedMatchesArticle(regenerated, article);
}

function regeneratedMatchesArticle(regenerated: SheetRecord, article: Article): boolean {
  const revisionCount = Number(eventPayload(regenerated).revision_count);
  return Number.isInteger(revisionCount) && revisionCount === numberCell(article.revision_count);
}

function terminalForHash(events: SheetRecord[], hash: string): SheetRecord | undefined {
  return [...events].reverse().find((event) => {
    if (!TERMINAL_EVENT_TYPES.has(stringCell(event.event_type))) return false;
    const payload = eventPayload(event);
    return [stringField(payload, "input_hash"), stringField(payload, "output_hash")].includes(hash);
  });
}

function matchingRegeneratedEvent(events: SheetRecord[], providerObjectId: string): SheetRecord | undefined {
  return [...events].reverse().find((event) =>
    stringCell(event.event_type) === "regenerated" &&
    stringCell(event.provider) === "system" &&
    stringCell(event.provider_object_id) === `system:${providerObjectId}`,
  );
}

function matchingRegenerationAttemptEvent(
  events: SheetRecord[],
  providerObjectId: string,
): SheetRecord | undefined {
  return [...events].reverse().find((event) =>
    stringCell(event.event_type) === "regeneration_attempt_started" &&
    stringCell(event.provider) === "system" &&
    stringCell(event.provider_object_id) === `system:${providerObjectId}`,
  );
}

function interruptedRecovery(
  terminal: SheetRecord,
  events: SheetRecord[],
  article: Article,
  currentHash: string,
): InterruptedRecovery | undefined {
  if (stringCell(terminal.event_type) !== "auto_qa_repair_exhausted") return undefined;
  const terminalPayload = eventPayload(terminal);
  if (stringField(terminalPayload, "detail") !== "interrupted_after_attempt_started") {
    return undefined;
  }
  const startedEventId = stringField(terminalPayload, "started_event_id");
  const started = events.find((event) =>
    stringCell(event.event_id) === startedEventId &&
    stringCell(event.event_type) === "auto_qa_repair_started",
  );
  if (!started) return undefined;
  const identity = identityFromStarted(article.article_id, started);
  if (
    identity.inputHash !== currentHash ||
    matchingRegenerationAttemptEvent(events, identity.providerObjectId) ||
    hasHumanActivityAfter(events, started)
  ) {
    return undefined;
  }

  return {
    started,
    terminal,
  };
}

function systemCreatedManualGateCanBeRecovered(
  started: SheetRecord,
  terminal: SheetRecord,
  article: Article,
): boolean {
  if (!booleanCell(article.manual_required)) return false;
  const blockers = [
    stringField(eventPayload(terminal), "qa_blockers"),
    stringCell(article.qa_blockers),
  ].join(",").split(",").map((value) => value.trim()).filter(Boolean);
  if (
    blockers.includes("manual_required") ||
    blockers.some((blocker) =>
      GENERATED_QA_BLOCKER_CODES.includes(blocker as GeneratedQaBlockerCode) &&
      isSemanticGeneratedQaBlocker(blocker as GeneratedQaBlockerCode),
    )
  ) return false;

  // Legacy starts do not prove who owned an existing manual gate. Only a
  // durable pre-attempt snapshot may authorize clearing the system-created flag.
  return optionalBooleanField(
    eventPayload(started),
    "manual_required_before_attempt",
  ) === false;
}

function hasHumanActivityAfter(events: SheetRecord[], event: SheetRecord): boolean {
  return events.some((candidate) =>
    candidate.__rowNumber > event.__rowNumber &&
    stringCell(candidate.actor_type) !== "system",
  );
}

function terminalEvent(options: {
  eventId: string;
  eventType: "auto_qa_repair_completed" | "auto_qa_repair_exhausted";
  article: Article;
  identity: RepairIdentity;
  toStatus: "needs_review" | "failed_qa";
  outcome: "passed" | "exhausted";
  detail: string;
  createdAt: string;
}): AuditEvent {
  return {
    event_id: options.eventId,
    article_id: options.article.article_id,
    event_type: options.eventType,
    from_status: options.article.status,
    to_status: options.toStatus,
    actor_type: "system",
    actor_id: ACTOR_ID,
    provider: "system",
    provider_object_id: options.identity.providerObjectId,
    message: options.outcome === "passed"
      ? "Automatic QA repair passed"
      : "Automatic QA repair exhausted",
    payload_json: JSON.stringify({
      hash: options.identity.inputHash,
      input_hash: options.identity.inputHash,
      output_hash: articleContentHash(options.article),
      attempt: 1,
      max_attempts: MAX_ATTEMPTS,
      outcome: options.outcome,
      detail: options.detail,
      started_event_id: options.identity.startedEventId,
      qa_blockers: stringCell(options.article.qa_blockers),
    }),
    created_at: options.createdAt,
  };
}

function eventPayload(event: SheetRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stringCell(event.payload_json)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : "";
}

function optionalBooleanField(
  payload: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = payload[field];
  return typeof value === "boolean" ? value : undefined;
}

function stableEventId(kind: string, source: string): string {
  const hash = createHash("sha256").update(`${kind}:${source}`).digest("hex").slice(0, 24);
  return `evt-${kind}-${hash}`;
}

function telegramOptions(): {
  parse_mode: "HTML";
  link_preview_options: { is_disabled: true };
  reply_markup: { inline_keyboard: [] };
} {
  return {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [] },
  };
}

function progressMessage(): string {
  return [
    "🛠 <b>Черновик создан, но требует доработки.</b>",
    `Проверяю и исправляю статью автоматически — попытка 1 из ${MAX_ATTEMPTS}.`,
    "Ничего делать пока не нужно.",
  ].join("\n");
}

function exhaustedMessage(article: Article, spreadsheetId: string): string {
  const url = articleSheetUrl(spreadsheetId, article.__rowNumber);
  return [
    "⚠️ <b>Не удалось исправить статью автоматически.</b>",
    "Черновик сохранён, но публикация заблокирована до ручной проверки.",
    "",
    "Откройте строку, внесите правки и отправьте:",
    "/regenerate ваш комментарий",
    "",
    `<a href="${escapeHtml(url)}">Открыть статью в Google Sheets</a>`,
  ].join("\n");
}
