import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import {
  articleContentHash,
  booleanCell,
  dateCell,
  numberCell,
  parseListCell,
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
import type { GeneratedArticle, OpenAiArticleGenerator } from "../generation/openai-generator.js";
import {
  classifyOpenAiApiError,
  OPENAI_FAILURE_REASONS,
  type OpenAiFailureReason,
} from "../generation/openai-error.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { AuditEvent, GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { HeroImageService } from "./hero-image-service.js";
import type { InitialGenerationCheckpointStore } from "./initial-generation-checkpoint-store.js";
import { QualityGate } from "./quality-gate.js";

const CLAIMED_STATUS = "assigned";

type GenerationFailureStage =
  | "article_generation"
  | "hero_image"
  | "quality_gate"
  | "article_persist";

export type ManualGenerationBlockReason =
  | "generator_not_configured"
  | "manual_generation_disabled"
  | "no_ready_keywords"
  | "invalid_keyword_row"
  | "duplicate_keyword_id"
  | "keyword_row_changed"
  | "request_conflict"
  | "locale_disabled"
  | "ru_disabled"
  | "no_internal_links"
  | "active_review_exists"
  | "multiple_active_reviews"
  | "generation_in_progress"
  | "previous_generation_failed";

export type InvalidKeywordField = "keyword_id" | "locale" | "primary_keyword" | "article_id";

export type ManualGenerationRequest = {
  actorId: number;
  actorName: string;
  providerObjectId: string;
};

export type ManualGenerationResult =
  | {
      outcome: "queued" | "resumed" | "already_queued" | "already_generated" | "previous_failed";
      keywordId: string;
      articleId: string;
      locale: string;
      keyword: string;
      rowNumber: number;
    }
  | {
      outcome: "blocked";
      reason: ManualGenerationBlockReason;
      locale?: string;
      rowNumber?: number;
      keywordId?: string;
      invalidFields?: InvalidKeywordField[];
      conflictingRows?: number[];
      articleId?: string;
      telegramMessageId?: number;
      allowedLocales?: string[];
      activeCount?: number;
    };

export type RegenerationRequest = {
  articleId: string;
  feedback?: string;
  actorId: number | string;
  actorName: string;
  providerObjectId: string;
  actorType?: "telegram_user" | "system";
  provider?: "telegram" | "system";
  /** Fail closed when the article changed after an automatic repair was selected. */
  expectedContentHash?: string;
  /** Automatic repair may only spend against a draft that still fails QA. */
  requireQaFailure?: boolean;
  /** Fail closed if a reviewer changes the manual gate while the model is working. */
  expectedManualRequired?: boolean;
  /** Fail closed if a reviewer changes QA blockers while the model is working. */
  expectedQaBlockers?: string;
  /**
   * The current manual flag was written by an interrupted automatic-repair
   * terminal, rather than by a human or the quality gate. This narrowly lets
   * the recovered system attempt replace that flag with its fresh QA result.
   */
  recoverSystemManualGate?: boolean;
};

export type RegenerationResult =
  | { outcome: "regenerated" | "already_regenerated"; article: Article }
  | {
      outcome: "blocked";
      reason:
        | "generator_not_configured"
        | "manual_generation_disabled"
        | "ambiguous_attempt"
        | "stale_article"
        | "invalid_status"
        | "locale_disabled"
        | "ru_disabled"
        | "no_internal_links";
      article?: Article;
    };

export class GenerationService {
  #running = false;
  readonly #requestMutex = new KeyedMutex();

  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly generator: OpenAiArticleGenerator | undefined,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly qualityGate: QualityGate = new QualityGate(store, config),
    private readonly workflowMutex: KeyedMutex = new KeyedMutex(),
    private readonly heroImages?: HeroImageService,
    private readonly initialCheckpoints?: InitialGenerationCheckpointStore,
  ) {}

  /** Scheduled queue. The Sheet generation_enabled flag is an absolute gate. */
  async runOnce(preferredKeywordId?: string): Promise<void> {
    await this.#runQueue("scheduled", preferredKeywordId);
  }

  /** Telegram queue. It has separate server and Sheet kill switches. */
  async runManualOnce(): Promise<void> {
    await this.#runQueue("manual");
  }

  async requestManualGeneration(request: ManualGenerationRequest): Promise<ManualGenerationResult> {
    if (!this.generator) return { outcome: "blocked", reason: "generator_not_configured" };
    const settings = await this.store.getSettings();
    if (!manualGenerationIsEnabled(this.config, settings)) {
      return { outcome: "blocked", reason: "manual_generation_disabled" };
    }
    const requestArticleId = manualRequestArticleId(request.providerObjectId);
    return this.#requestMutex.runExclusive("keyword-claim", async () => {
      const allKeywords = await this.store.listKeywords(undefined, { includeIncomplete: true });
      const existing = allKeywords.find(
        (candidate) => stringCell(candidate.article_id).toLowerCase() === requestArticleId.toLowerCase(),
      );
      if (existing) {
        if (!(await this.#hasValidManualRequest(existing))) {
          return blockedForKeyword("request_conflict", existing, {
            ...(stringCell(existing.article_id) ? { articleId: stringCell(existing.article_id) } : {}),
          });
        }
        return resultForExistingKeyword(existing);
      }
      const duplicateEvent = await this.store.findEventByProviderObjectId(
        "telegram",
        request.providerObjectId,
        "generation_requested",
      );
      if (duplicateEvent) {
        const candidate = allKeywords.find(
          (row) =>
            stringCell(row.article_id).toLowerCase() ===
              stringCell(duplicateEvent.article_id).toLowerCase(),
        );
        if (!candidate) {
          return {
            outcome: "blocked",
            reason: "request_conflict",
            articleId: stringCell(duplicateEvent.article_id),
          };
        }
        const candidateArticleId = stringCell(candidate.article_id);
        if (!(await this.#hasValidManualRequest(candidate))) {
          return blockedForKeyword("request_conflict", candidate, { articleId: candidateArticleId });
        }
        return resultForExistingKeyword(candidate);
      }

      const activeGenerationRequests = allKeywords
        .filter((candidate) => [CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status)))
        .sort((left, right) =>
          left.__rowNumber - right.__rowNumber ||
          stringCell(left.keyword_id).localeCompare(stringCell(right.keyword_id)),
        );
      const activeReviews = (await this.store.listArticles(["needs_review", "failed_qa"]))
        .sort((left, right) =>
          left.__rowNumber - right.__rowNumber || left.article_id.localeCompare(right.article_id),
        );
      if (activeReviews.length > 0) {
        const activeReview = activeReviews[0]!;
        const telegramMessageId = Number(activeReview.telegram_message_id);
        return {
          outcome: "blocked",
          reason: activeReviews.length === 1 ? "active_review_exists" : "multiple_active_reviews",
          articleId: activeReview.article_id,
          rowNumber: activeReview.__rowNumber,
          ...(Number.isSafeInteger(telegramMessageId) && telegramMessageId > 0
            ? { telegramMessageId }
            : {}),
          activeCount: activeReviews.length,
          ...(activeReviews.length > 1
            ? { conflictingRows: activeReviews.map((article) => article.__rowNumber) }
            : {}),
        };
      }
      if (activeGenerationRequests.length > 0) {
        const activeRequest = activeGenerationRequests[0]!;
        const activeArticleId = stringCell(activeRequest.article_id);
        return blockedForKeyword("generation_in_progress", activeRequest, {
          ...(activeArticleId ? { articleId: activeArticleId } : {}),
          activeCount: activeGenerationRequests.length,
          ...(activeGenerationRequests.length > 1
            ? { conflictingRows: activeGenerationRequests.map((candidate) => candidate.__rowNumber) }
            : {}),
        });
      }

      const recoverable = await this.#recoverableKeyword(allKeywords);
      const unresolved = await this.#unresolvedManualKeyword(allKeywords);
      const [recoverableRank, unresolvedRank] = await Promise.all([
        recoverable ? this.#pausedEventRank(recoverable) : Promise.resolve(-1),
        unresolved ? this.#pausedEventRank(unresolved) : Promise.resolve(-1),
      ]);
      if (unresolved && (!recoverable || unresolvedRank > recoverableRank)) {
        return blockedForKeyword("previous_generation_failed", unresolved, {
          articleId: stringCell(unresolved.article_id),
        });
      }
      const keyword = recoverable ?? allKeywords
        .filter((candidate) => stringCell(candidate.status) === "ready")
        .sort((left, right) => left.__rowNumber - right.__rowNumber)[0];
      if (!keyword) return { outcome: "blocked", reason: "no_ready_keywords" };

      const keywordId = stringCell(keyword.keyword_id);
      const normalizedKeyword = normalizeManualKeyword(stringCell(keyword.primary_keyword));
      const locale = stringCell(keyword.locale).toLowerCase();
      const isRecovery = Boolean(recoverable && recoverable.__rowNumber === keyword.__rowNumber);
      const sourceStatus = stringCell(keyword.status);
      const requestFromStatus: "ready" | "paused" = isRecovery && sourceStatus === "paused"
        ? "paused"
        : "ready";
      const articleId = isRecovery ? stringCell(keyword.article_id) : requestArticleId;
      const invalidFields: InvalidKeywordField[] = [];
      if (!keywordId) invalidFields.push("keyword_id");
      if (!locale) invalidFields.push("locale");
      if (
        normalizedKeyword.length < 2 ||
        normalizedKeyword.length > 200 ||
        /[\u0000-\u001F\u007F]/u.test(normalizedKeyword)
      ) {
        invalidFields.push("primary_keyword");
      }
      if (!isRecovery && stringCell(keyword.article_id)) invalidFields.push("article_id");
      if (invalidFields.length > 0) {
        return blockedForKeyword("invalid_keyword_row", keyword, {
          invalidFields,
          ...(stringCell(keyword.article_id) ? { articleId: stringCell(keyword.article_id) } : {}),
        });
      }

      const conflictingRows = allKeywords
        .filter((candidate) => stringCell(candidate.keyword_id).toLowerCase() === keywordId.toLowerCase())
        .map((candidate) => candidate.__rowNumber)
        .sort((left, right) => left - right);
      if (conflictingRows.length > 1) {
        return blockedForKeyword("duplicate_keyword_id", keyword, { conflictingRows });
      }
      const allowedLocales = parseListCell(settings.get("enabled_locales")).map((value) => value.toLowerCase());
      const enabledLocales = new Set(allowedLocales);
      if (locale === "ru" && !booleanCell(settings.get("ru_enabled"))) {
        return blockedForKeyword("ru_disabled", keyword, { allowedLocales });
      }
      if (!locale || !enabledLocales.has(locale)) {
        return blockedForKeyword("locale_disabled", keyword, { allowedLocales });
      }

      const links = await this.store.listLinks();
      const hasInternalLink = links.some(
        (link) =>
          stringCell(link.environment).toLowerCase() === this.config.targetEnvironment.toLowerCase() &&
          stringCell(link.status).toLowerCase() === "active" &&
          booleanCell(link.allow_internal_link) &&
          ["all", locale].includes(stringCell(link.locale).toLowerCase()),
      );
      if (!hasInternalLink) return blockedForKeyword("no_internal_links", keyword);

      const now = new Date().toISOString();
      const claimed = await this.store.patchKeywordAndAppendEvent(
        keywordId,
        {
          status: CLAIMED_STATUS,
          article_id: articleId,
          updated_at: now,
        },
        requestedEvent(
          request,
          keywordId,
          articleId,
          normalizedKeyword,
          locale,
          keyword.__rowNumber,
          now,
          this.config.telegramBotToken,
          requestFromStatus,
          isRecovery,
        ),
        {
          status: requestFromStatus,
          article_id: isRecovery ? articleId : "",
          locale: keyword.locale ?? "",
          primary_keyword: keyword.primary_keyword ?? "",
        },
      );
      if (claimed === false) {
        return blockedForKeyword("keyword_row_changed", keyword);
      }
      return {
        outcome: isRecovery ? "resumed" : "queued",
        keywordId,
        articleId,
        locale,
        keyword: normalizedKeyword,
        rowNumber: keyword.__rowNumber,
      };
    });
  }

  async regenerateArticle(request: RegenerationRequest): Promise<RegenerationResult> {
    if (!this.generator) return { outcome: "blocked", reason: "generator_not_configured" };

    return this.workflowMutex.runExclusive(request.articleId, async () => {
      const article = await this.store.findArticle(request.articleId);
      if (!article) throw new Error(`Article not found: ${request.articleId}`);

      const baseContentHash = articleContentHash(article);
      if (
        (request.expectedContentHash && request.expectedContentHash !== baseContentHash) ||
        (request.requireQaFailure && stringCell(article.qa_status) !== "fail") ||
        (
          request.expectedManualRequired !== undefined &&
          booleanCell(article.manual_required) !== request.expectedManualRequired
        ) ||
        (
          request.expectedQaBlockers !== undefined &&
          stringCell(article.qa_blockers) !== request.expectedQaBlockers
        )
      ) {
        return { outcome: "blocked", reason: "stale_article", article };
      }

      const provider = request.provider ?? "telegram";
      const commandId = providerCommandId(provider, request.providerObjectId);
      const events = await this.store.listEvents(article.article_id);
      if (
        events.some(
          (event) =>
            stringCell(event.event_type) === "regenerated" &&
            stringCell(event.provider_object_id) === commandId,
        )
      ) {
        return { outcome: "already_regenerated", article };
      }
      if (article.status !== "needs_review" && article.status !== "failed_qa") {
        return { outcome: "blocked", reason: "invalid_status", article };
      }

      const settings = await this.store.getSettings();
      if (provider !== "system" && !manualGenerationIsEnabled(this.config, settings)) {
        return { outcome: "blocked", reason: "manual_generation_disabled", article };
      }
      const [guardrails, links] = await Promise.all([
        this.store.listGuardrails(),
        this.store.listLinks(),
      ]);
      const locale = stringCell(article.locale).toLowerCase();
      const enabledLocales = new Set(
        parseListCell(settings.get("enabled_locales")).map((value) => value.toLowerCase()),
      );
      if (locale === "ru" && !booleanCell(settings.get("ru_enabled"))) {
        return { outcome: "blocked", reason: "ru_disabled", article };
      }
      if (!locale || !enabledLocales.has(locale)) {
        return { outcome: "blocked", reason: "locale_disabled", article };
      }
      const allowedLinks = links.filter(
        (link) =>
          stringCell(link.environment) === this.config.targetEnvironment &&
          stringCell(link.status) === "active" &&
          booleanCell(link.allow_internal_link) &&
          ["all", locale].includes(stringCell(link.locale)),
      );
      if (allowedLinks.length === 0) {
        return { outcome: "blocked", reason: "no_internal_links", article };
      }
      const attemptEventId = stableEventId("regeneration_attempt_started", commandId);
      if (events.some((event) => stringCell(event.event_id) === attemptEventId)) {
        // The previous process may have received a paid response without committing it.
        // Replaying would be financially ambiguous, so require a new explicit command.
        return { outcome: "blocked", reason: "ambiguous_attempt", article };
      }
      const currentQuality = await this.qualityGate.evaluate({
        ...article,
        manual_required: false,
      });
      const originalKeyword = await this.store.findKeyword(stringCell(article.keyword_id));
      const keywordBrief = originalKeyword ?? article;
      const feedback = stringCell(request.feedback);
      const storedEditorFeedback = provider === "system" && stringCell(article.feedback)
        ? stringCell(article.feedback)
        : feedback;
      await this.store.appendEvent({
        event_id: attemptEventId,
        article_id: article.article_id,
        event_type: "regeneration_attempt_started",
        from_status: article.status,
        to_status: article.status,
        actor_type: request.actorType ?? "telegram_user",
        actor_id: String(request.actorId),
        provider,
        provider_object_id: commandId,
        message: `Paid regeneration attempt started by ${request.actorName}`,
        payload_json: JSON.stringify({
          base_hash: articleContentHash(article),
          model: this.config.openAiModel,
          feedback: feedback || null,
          editor_feedback: storedEditorFeedback || null,
        }),
        created_at: new Date().toISOString(),
      });
      const generated = await this.generator!.generate({
        keyword: {
          ...keywordBrief,
          locale: article.locale,
          primary_keyword: stringCell(article.primary_keyword) || stringCell(keywordBrief.primary_keyword),
          topic_angle:
            stringCell(keywordBrief.topic_angle) ||
            stringCell(article.topic) ||
            stringCell(article.primary_keyword),
          research_notes: stringCell(keywordBrief.research_notes),
        },
        guardrails,
        allowedLinks,
        targetWords: numberCell(settings.get("default_article_length_words")) || 1_200,
        revision: {
          article,
          ...(feedback ? { feedback } : {}),
          deterministicBlockers: currentQuality.blockers,
        },
      });

      const now = new Date().toISOString();
      const generatedFields = generatedArticleFields(generated);
      let candidate = {
        ...article,
        ...generatedFields,
        status: "needs_review",
        qa_status: "pass",
        qa_blockers: "",
        manual_required: false,
        updated_at: now,
      } as Article;
      const heroImageFields = await this.#prepareHeroImage(candidate);
      candidate = { ...candidate, ...heroImageFields } as Article;
      const quality = await this.#evaluateGeneratedCandidate(candidate, generated.qa_blockers);
      const stickyManualRequired = provider === "system" &&
        booleanCell(article.manual_required) &&
        !request.recoverSystemManualGate;
      const manualRequired = quality.manualRequired || stickyManualRequired;
      const blockers = stickyManualRequired && !quality.blockers.includes("manual_required")
        ? [...quality.blockers, "manual_required"].sort()
        : quality.blockers;
      const finalStatus = blockers.length === 0 ? "needs_review" : "failed_qa";
      const revisionCount = numberCell(article.revision_count) + 1;
      const latest = await this.store.findArticle(article.article_id);
      if (
        !latest ||
        latest.status !== article.status ||
        numberCell(latest.revision_count) !== numberCell(article.revision_count) ||
        articleContentHash(latest) !== baseContentHash ||
        (request.requireQaFailure && stringCell(latest.qa_status) !== "fail") ||
        (
          request.expectedManualRequired !== undefined &&
          booleanCell(latest.manual_required) !== request.expectedManualRequired
        ) ||
        (
          request.expectedQaBlockers !== undefined &&
          stringCell(latest.qa_blockers) !== request.expectedQaBlockers
        )
      ) {
        return { outcome: "blocked", reason: "stale_article", ...(latest ? { article: latest } : {}) };
      }
      const updated = await this.store.patchArticleAndAppendEvent(
        article.article_id,
        {
          ...generatedFields,
          ...heroImageFields,
          status: finalStatus,
          qa_status: blockers.length === 0 ? "pass" : "fail",
          qa_blockers: blockers.join(","),
          manual_required: manualRequired,
          revision_count: revisionCount,
          content_hash: "",
          approved_by: "",
          approved_at: "",
          ghost_post_id: "",
          ghost_updated_at: "",
          ghost_draft_url: "",
          public_url: "",
          published_at: "",
          last_error: "",
          ...(storedEditorFeedback ? { feedback: storedEditorFeedback } : {}),
          updated_at: now,
        },
        {
          event_id: stableEventId("regenerated", request.providerObjectId),
          article_id: article.article_id,
          event_type: "regenerated",
          from_status: article.status,
          to_status: finalStatus,
          actor_type: request.actorType ?? "telegram_user",
          actor_id: String(request.actorId),
          provider,
          provider_object_id: commandId,
          message: `Regenerated by ${request.actorName}`,
          payload_json: JSON.stringify({
            previous_hash: articleContentHash(article),
            revision_count: revisionCount,
            feedback: feedback || null,
            editor_feedback: storedEditorFeedback || null,
            model: this.config.openAiModel,
            qa_blockers: blockers,
            revision_audit: generated.revision_audit ?? null,
          }),
          created_at: now,
        },
      );
      return { outcome: "regenerated", article: updated };
    });
  }

  async #runQueue(queue: "manual" | "scheduled", preferredKeywordId?: string): Promise<void> {
    if (this.#running || !this.generator) return;
    this.#running = true;
    try {
      const settings = await this.store.getSettings();
      if (queue === "manual") {
        if (!manualGenerationIsEnabled(this.config, settings)) return;
      } else if (!booleanCell(settings.get("generation_enabled") ?? false)) {
        return;
      }

      const keyword = await this.#requestMutex.runExclusive("keyword-claim", async () => {
        const statuses = queue === "manual"
          ? [CLAIMED_STATUS, "generating"]
          : ["ready", CLAIMED_STATUS, "generating"];
        const candidates = await this.store.listKeywords(statuses);
        const inFlightCandidates = candidates
          .filter((candidate) =>
            [CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status)),
          )
          .sort((left, right) =>
            left.__rowNumber - right.__rowNumber ||
            stringCell(left.keyword_id).localeCompare(stringCell(right.keyword_id)),
          );
        const activeReviews = await this.store.listArticles(["needs_review", "failed_qa"]);
        const manualFlags = await Promise.all(
          candidates.map((candidate) => this.#hasManualRequestEvent(candidate)),
        );
        const keywords = candidates
          .filter((_candidate, index) => queue === "manual" ? manualFlags[index] : !manualFlags[index])
          .filter((candidate) =>
            [CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status))
              ? true
              : isDue(candidate, stringCell(settings.get("timezone")) || "Europe/Belgrade"),
          )
          .sort((left, right) => {
            const recoveryOrder =
              Number([CLAIMED_STATUS, "generating"].includes(stringCell(right.status))) -
              Number([CLAIMED_STATUS, "generating"].includes(stringCell(left.status)));
            if (recoveryOrder) return recoveryOrder;
            if (queue === "scheduled") {
              const numericPriority = numberCell(right.priority) - numberCell(left.priority);
              if (numericPriority) return numericPriority;
            }
            return left.__rowNumber - right.__rowNumber;
          });
        const recoveries = keywords.filter((candidate) =>
          [CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status)),
        );
        const preferred = queue === "scheduled" && preferredKeywordId
          ? keywords.find(
              (candidate) =>
                stringCell(candidate.keyword_id).toLowerCase() === preferredKeywordId.trim().toLowerCase(),
            )
          : undefined;
        let selected: SheetRecord | undefined;
        if (activeReviews.length > 1) {
          return undefined;
        }
        if (activeReviews.length === 1) {
          const activeArticleId = activeReviews[0]!.article_id.toLowerCase();
          selected = recoveries.find(
            (candidate) => stringCell(candidate.article_id).toLowerCase() === activeArticleId,
          );
        } else if (preferred) {
          selected = preferred;
        } else if (inFlightCandidates.length > 0) {
          const inFlight = inFlightCandidates[0]!;
          selected = recoveries.find((candidate) => candidate.__rowNumber === inFlight.__rowNumber);
        } else {
          selected = keywords[0];
        }
        if (!selected) return undefined;

        if (stringCell(selected.status) !== CLAIMED_STATUS || !stringCell(selected.article_id)) {
          const articleId = stringCell(selected.article_id) || createArticleId();
          const claimedAt = new Date().toISOString();
          await this.store.patchKeyword(stringCell(selected.keyword_id), {
            status: CLAIMED_STATUS,
            article_id: articleId,
            updated_at: claimedAt,
          });
          selected = { ...selected, status: CLAIMED_STATUS, article_id: articleId, updated_at: claimedAt };
        }
        return selected;
      });
      if (!keyword) return;
      if (queue === "manual") {
        const blockReason = await this.#manualExecutionBlockReason(keyword, settings);
        if (blockReason) {
          await this.#blockKeyword(keyword, blockReason);
          return;
        }
      }
      await this.#generateKeyword(keyword, settings);
    } finally {
      this.#running = false;
    }
  }

  async #manualExecutionBlockReason(
    keyword: SheetRecord,
    settings: Map<string, CellValue>,
  ): Promise<string | undefined> {
    if (!(await this.#hasValidManualRequest(keyword))) return "invalid_manual_request";
    const locale = stringCell(keyword.locale).toLowerCase();
    if (locale === "ru" && !booleanCell(settings.get("ru_enabled"))) return "ru_disabled";
    const enabledLocales = new Set(
      parseListCell(settings.get("enabled_locales")).map((value) => value.toLowerCase()),
    );
    if (!locale || !enabledLocales.has(locale)) return "locale_disabled";
    const links = await this.store.listLinks();
    const hasInternalLink = links.some(
      (link) =>
        stringCell(link.environment).toLowerCase() === this.config.targetEnvironment.toLowerCase() &&
        stringCell(link.status).toLowerCase() === "active" &&
        booleanCell(link.allow_internal_link) &&
        ["all", locale].includes(stringCell(link.locale).toLowerCase()),
    );
    return hasInternalLink ? undefined : "no_internal_links";
  }

  async #recoverableKeyword(allKeywords: SheetRecord[]): Promise<SheetRecord | undefined> {
    const candidates = await this.#recoveryCandidatesNewestFirst(allKeywords);

    for (const candidate of candidates) {
      const articleId = stringCell(candidate.article_id);
      const events = await this.store.listEvents(articleId);
      // A completed generation is terminal for this article id. Sheet row
      // reordering must never make an older signed failure spend again.
      if (events.some((event) => stringCell(event.event_type) === "generated")) continue;
      const request = latestEvent(
        events,
        (event) =>
          stringCell(event.event_type) === "generation_requested" &&
          stringCell(event.actor_type) === "telegram_user" &&
          stringCell(event.provider) === "telegram",
      );
      // A ready row with an article id is normally invalid. Trust it as a
      // recovery candidate only when it still belongs to a signed Telegram
      // request; this prevents arbitrary Sheet edits from attaching an article.
      if (
        stringCell(candidate.status) === "ready" &&
        (
          !request ||
          !eventIdIsUnique(events, request) ||
          !(await this.#hasValidManualRequest(candidate))
        )
      ) {
        continue;
      }
      const article = await this.store.findArticle(articleId);
      if (
        article &&
        stringCell(article.keyword_id) === stringCell(candidate.keyword_id) &&
        stringCell(article.body_markdown) &&
        ["generating", "qa_pending", "failed_generation"].includes(article.status)
      ) {
        return candidate;
      }

      if (this.initialCheckpoints) {
        try {
          const checkpoint = await this.initialCheckpoints.load(articleId);
          if (checkpoint && checkpoint.keywordId === stringCell(candidate.keyword_id)) return candidate;
        } catch (error) {
          this.logger.error(
            { articleId, err: error instanceof Error ? error.message : String(error) },
            "Initial generation checkpoint could not be inspected",
          );
        }
      }

      const failure = latestEvent(
        events,
        (event) => ["generation_failed", "generation_blocked"].includes(stringCell(event.event_type)),
      );
      if (!failure) continue;
      const attempt = latestEvent(
        events,
        (event) => stringCell(event.event_type) === "generation_attempt_started",
      );
      const latestTerminal = latestEvent(
        events,
        (event) => [
          "generation_requested",
          "generation_attempt_started",
          "generation_failed",
          "generation_blocked",
          "generated",
        ].includes(stringCell(event.event_type)),
      );
      if (
        !eventIdIsUnique(events, failure) ||
        (request && !eventIdIsUnique(events, request)) ||
        (attempt && !eventIdIsUnique(events, attempt))
      ) continue;
      if (!isExplicitlyRecoverableStop(
        failure,
        candidate,
        request,
        attempt,
        this.config.telegramBotToken,
      )) continue;
      if (!request || latestTerminal?.__rowNumber !== failure.__rowNumber) continue;
      if (stringCell(failure.event_type) === "generation_failed") {
        if (!attempt || !(request.__rowNumber < attempt.__rowNumber && attempt.__rowNumber < failure.__rowNumber)) {
          continue;
        }
      } else if (!(request.__rowNumber < failure.__rowNumber)) {
        continue;
      }
      if (await this.#hasValidManualRequest(candidate)) return candidate;
    }
    return undefined;
  }

  async #recoveryCandidatesNewestFirst(allKeywords: SheetRecord[]): Promise<SheetRecord[]> {
    const candidates = allKeywords
      .filter((candidate) => {
        const status = stringCell(candidate.status);
        return status === "paused" || (status === "ready" && Boolean(stringCell(candidate.article_id)));
      })
      .filter((candidate) => Boolean(stringCell(candidate.keyword_id) && stringCell(candidate.article_id)));
    const ranked = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        rank: await this.#pausedEventRank(candidate),
      })),
    );
    return ranked
      .sort((left, right) =>
        right.rank - left.rank ||
        right.candidate.__rowNumber - left.candidate.__rowNumber,
      )
      .map(({ candidate }) => candidate);
  }

  async #unresolvedManualKeyword(allKeywords: SheetRecord[]): Promise<SheetRecord | undefined> {
    const candidates = await this.#recoveryCandidatesNewestFirst(allKeywords);
    for (const candidate of candidates) {
      const events = await this.store.listEvents(stringCell(candidate.article_id));
      const request = latestEvent(
        events,
        (event) =>
          stringCell(event.event_type) === "generation_requested" &&
          stringCell(event.actor_type) === "telegram_user" &&
          stringCell(event.provider) === "telegram",
      );
      if (request) return candidate;
    }
    return undefined;
  }

  async #pausedEventRank(keyword: SheetRecord): Promise<number> {
    const articleId = stringCell(keyword.article_id);
    if (!articleId) return -1;
    const events = await this.store.listEvents(articleId);
    const latestRequest = latestEvent(
      events,
      (event) =>
        stringCell(event.event_type) === "generation_requested" &&
        stringCell(event.actor_type) === "telegram_user" &&
        stringCell(event.provider) === "telegram",
    );
    if (latestRequest) return latestRequest.__rowNumber;
    return events
      .filter((event) => [
        "generation_attempt_started",
        "hero_image_attempt_started",
        "generation_failed",
        "generation_blocked",
        "generated",
      ].includes(stringCell(event.event_type)))
      .reduce((latest, event) => Math.max(latest, event.__rowNumber), -1);
  }

  async #generateKeyword(keyword: SheetRecord, settings: Map<string, CellValue>): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id) || createArticleId();
    const priorEvents = await this.store.listEvents(articleId);
    const requestEvent = latestEvent(
      priorEvents,
      (event) =>
        stringCell(event.event_type) === "generation_requested" &&
        stringCell(event.actor_type) === "telegram_user" &&
        stringCell(event.provider) === "telegram" &&
        Boolean(stringCell(event.provider_object_id)),
    );
    const requestKey = requestEvent
      ? stringCell(requestEvent.provider_object_id)
      : `scheduled:${keywordId}:${articleId}`;
    let article = await this.store.findArticle(articleId);
    if (article && stringCell(article.body_markdown)) {
      const latestHeroAttempt = latestEvent(
        priorEvents,
        (event) => stringCell(event.event_type) === "hero_image_attempt_started",
      );
      if (
        !stringCell(article.feature_image_url) &&
        latestHeroAttempt &&
        (!requestEvent || latestHeroAttempt.__rowNumber > requestEvent.__rowNumber)
      ) {
        await this.#failKeyword(
          keyword,
          new Error("A previous hero-image attempt ended without a committed image; automatic replay is disabled"),
          "hero_image",
        );
        return;
      }
      await this.#removeInitialCheckpointBestEffort(articleId);
      if (["generating", "qa_pending", "failed_generation"].includes(article.status)) {
        await this.store.patchKeyword(keywordId, {
          status: "generating",
          updated_at: new Date().toISOString(),
        });
        await this.#finishInitialArticle(keyword, article);
      } else {
        await this.#completeKeyword(keyword, articleId, article.status);
      }
      return;
    }

    let checkpoint;
    try {
      checkpoint = await this.initialCheckpoints?.load(articleId);
    } catch (error) {
      await this.#failKeyword(keyword, error, "article_persist");
      return;
    }

    if (checkpoint) {
      if (checkpoint.keywordId !== keywordId) {
        await this.#failKeyword(
          keyword,
          new Error(`Saved generation checkpoint belongs to a different keyword`),
          "article_persist",
        );
        return;
      }
      article = article ?? await this.#ensureInitialArticle(keyword, articleId);
      try {
        article = await this.#persistGeneratedText(articleId, checkpoint.generated);
        await this.#removeInitialCheckpointBestEffort(articleId);
        await this.store.patchKeyword(keywordId, {
          status: "generating",
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        await this.#failKeyword(keyword, error, "article_persist");
        return;
      }
      await this.#finishInitialArticle(keyword, article);
      return;
    }

    const latestFailure = latestEvent(
      priorEvents,
      (event) => ["generation_failed", "generation_blocked"].includes(stringCell(event.event_type)),
    );
    if (latestFailure && (!requestEvent || latestFailure.__rowNumber > requestEvent.__rowNumber)) {
      await this.store.patchKeyword(keywordId, {
        status: "paused",
        updated_at: new Date().toISOString(),
      });
      return;
    }
    const latestAttempt = latestEvent(
      priorEvents,
      (event) => stringCell(event.event_type) === "generation_attempt_started",
    );
    if (latestAttempt && (!requestEvent || latestAttempt.__rowNumber > requestEvent.__rowNumber)) {
      await this.#failKeyword(
        keyword,
        new Error("A previous paid generation attempt ended without a committed article; automatic replay is disabled"),
        "article_generation",
      );
      return;
    }

    try {
      article = article ?? await this.#ensureInitialArticle(keyword, articleId);
      await this.store.patchKeyword(keywordId, {
        status: "generating",
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      await this.#failKeyword(keyword, error, "article_persist");
      return;
    }

    let generated: GeneratedArticle;
    try {
      const [guardrails, links] = await Promise.all([
        this.store.listGuardrails(),
        this.store.listLinks(),
      ]);
      const targetWords = numberCell(settings.get("default_article_length_words")) || 1_200;
      await this.store.appendEvent({
        event_id: stableEventId("generation_attempt_started", `${articleId}:${requestKey}`),
        article_id: articleId,
        event_type: "generation_attempt_started",
        from_status: CLAIMED_STATUS,
        to_status: CLAIMED_STATUS,
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message: `Paid generation attempt started for keyword ${keywordId}`,
        payload_json: JSON.stringify({ keyword_id: keywordId, model: this.config.openAiModel }),
        created_at: new Date().toISOString(),
      });
      generated = await this.generator!.generate({
        keyword,
        guardrails,
        allowedLinks: links.filter(
          (link) => stringCell(link.environment) === this.config.targetEnvironment,
        ),
        targetWords,
      });
    } catch (error) {
      await this.#failKeyword(keyword, error, "article_generation");
      return;
    }

    let checkpointSaved = false;
    if (this.initialCheckpoints) {
      try {
        await this.initialCheckpoints.save({
          version: 1,
          articleId,
          keywordId,
          requestKey,
          model: this.config.openAiModel,
          generated,
          createdAt: new Date().toISOString(),
        });
        checkpointSaved = true;
      } catch (error) {
        this.logger.error(
          { keywordId, articleId, err: error instanceof Error ? error.message : String(error) },
          "Could not save the local paid-result checkpoint; attempting the Sheet write",
        );
      }
    }
    try {
      article = await this.#persistGeneratedText(articleId, generated);
      if (checkpointSaved) await this.#removeInitialCheckpointBestEffort(articleId);
    } catch (error) {
      const recovered = await this.store.findArticle(articleId);
      if (!recovered || !stringCell(recovered.body_markdown)) {
        await this.#failKeyword(keyword, error, "article_persist");
        return;
      }
      article = recovered;
      if (checkpointSaved) await this.#removeInitialCheckpointBestEffort(articleId);
      this.logger.warn({ keywordId, articleId }, "Generated text write response failed but the article text exists");
    }
    await this.#finishInitialArticle(keyword, article);
  }

  async #ensureInitialArticle(keyword: SheetRecord, articleId: string): Promise<Article> {
    const existing = await this.store.findArticle(articleId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const values: Record<string, CellValue> = {
      article_id: articleId,
      keyword_id: stringCell(keyword.keyword_id),
      translation_group_id: `TG-${stringCell(keyword.keyword_id)}`,
      locale: stringCell(keyword.locale),
      status: "generating",
      primary_keyword: stringCell(keyword.primary_keyword),
      secondary_keywords: stringCell(keyword.secondary_keywords),
      search_intent: stringCell(keyword.search_intent),
      article_type: stringCell(keyword.article_type),
      topic: stringCell(keyword.topic_angle) || stringCell(keyword.primary_keyword),
      title: "",
      slug: "",
      excerpt: "",
      seo_title: "",
      meta_description: "",
      body_markdown: "",
      tags: "",
      source_urls: "",
      internal_links: "",
      scheduled_publish_at: keyword.planned_publish_at ?? "",
      quality_score: 0,
      qa_status: "pending",
      qa_blockers: "",
      manual_required: false,
      revision_count: 0,
      last_error: "",
      created_at: now,
      updated_at: now,
    };
    try {
      await this.store.appendArticle(values);
    } catch (error) {
      const recovered = await this.store.findArticle(articleId);
      if (!recovered) throw error;
      return recovered;
    }
    const appended = await this.store.findArticle(articleId);
    if (!appended) throw new Error(`Initial article placeholder was not committed: ${articleId}`);
    return appended;
  }

  async #persistGeneratedText(articleId: string, generated: GeneratedArticle): Promise<Article> {
    const now = new Date().toISOString();
    const patch: Record<string, CellValue> = {
      ...generatedArticleFields(generated),
      status: "generating",
      qa_status: "pending",
      qa_blockers: generated.qa_blockers.join(","),
      manual_required: generated.qa_blockers.some(isSemanticGeneratedQaBlocker),
      quality_score: generated.quality_score,
      last_error: "",
      updated_at: now,
    };
    patch.content_hash = articleContentHash({ ...patch, __rowNumber: 0 });
    return this.store.patchArticle(articleId, patch);
  }

  async #finishInitialArticle(keyword: SheetRecord, input: Article): Promise<void> {
    const articleId = input.article_id;
    let article = input;
    if (article.status === "failed_generation") {
      try {
        article = await this.store.patchArticle(articleId, {
          status: "generating",
          last_error: "",
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        await this.#failKeyword(keyword, error, "article_persist");
        return;
      }
    }
    try {
      let heroPatch: Record<string, CellValue> = {};
      if (!stringCell(article.feature_image_url)) {
        await this.#recordHeroImageAttempt(article);
        heroPatch = await this.#prepareHeroImage(article);
      }
      article = await this.store.patchArticle(articleId, {
        ...heroPatch,
        status: "qa_pending",
        last_error: "",
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      await this.#failKeyword(keyword, error, "hero_image");
      return;
    }

    const modelBlockers = parseListCell(article.qa_blockers).filter(
      (blocker): blocker is GeneratedQaBlockerCode =>
        GENERATED_QA_BLOCKER_CODES.includes(blocker as GeneratedQaBlockerCode),
    );
    let quality: { blockers: string[]; manualRequired: boolean };
    try {
      quality = await this.#evaluateGeneratedCandidate(article, modelBlockers);
    } catch (error) {
      await this.#failKeyword(keyword, error, "quality_gate");
      return;
    }
    const qaStatus = quality.blockers.length === 0 ? "pass" : "fail";
    const finalStatus = qaStatus === "pass" && !quality.manualRequired
      ? "needs_review"
      : "failed_qa";
    try {
      const finalPatch: Record<string, CellValue> = {
        status: finalStatus,
        qa_status: qaStatus,
        qa_blockers: quality.blockers.join(","),
        manual_required: quality.manualRequired,
        last_error: "",
        updated_at: new Date().toISOString(),
      };
      finalPatch.content_hash = articleContentHash({ ...article, ...finalPatch });
      article = await this.store.patchArticle(articleId, finalPatch);
    } catch (error) {
      const recovered = await this.store.findArticle(articleId);
      if (!recovered || !["needs_review", "failed_qa"].includes(recovered.status)) {
        await this.#failKeyword(keyword, error, "article_persist");
        return;
      }
      this.logger.warn(
        { keywordId: stringCell(keyword.keyword_id), articleId },
        "Article finalization response failed but the final article exists",
      );
      article = recovered;
    }
    await this.#completeKeyword(keyword, articleId, article.status);
  }

  async #recordHeroImageAttempt(article: Article): Promise<void> {
    const events = await this.store.listEvents(article.article_id);
    const request = latestEvent(
      events,
      (event) =>
        stringCell(event.event_type) === "generation_requested" &&
        stringCell(event.actor_type) === "telegram_user" &&
        stringCell(event.provider) === "telegram",
    );
    const requestId = stringCell(request?.provider_object_id) || "scheduled";
    await this.store.appendEvent({
      event_id: stableEventId("hero_image_attempt_started", `${article.article_id}:${requestId}`),
      article_id: article.article_id,
      event_type: "hero_image_attempt_started",
      from_status: article.status,
      to_status: article.status,
      actor_type: "system",
      actor_id: "hero-image-generator",
      provider: "openai",
      message: `Hero image attempt started for ${article.article_id}`,
      payload_json: JSON.stringify({
        keyword_id: stringCell(article.keyword_id),
        request_id: requestId,
        model: this.config.openAiImageModel,
      }),
      created_at: new Date().toISOString(),
    });
  }

  async #markArticleGenerationFailure(articleId: string, error: unknown): Promise<void> {
    try {
      await this.store.patchArticle(articleId, {
        status: "failed_generation",
        last_error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        updated_at: new Date().toISOString(),
      });
    } catch (patchError) {
      this.logger.warn(
        { articleId, err: patchError instanceof Error ? patchError.message : String(patchError) },
        "Could not mark the saved article text as failed_generation",
      );
    }
  }

  async #removeInitialCheckpointBestEffort(articleId: string): Promise<void> {
    if (!this.initialCheckpoints) return;
    try {
      await this.initialCheckpoints.remove(articleId);
    } catch (error) {
      this.logger.warn(
        { articleId, err: error instanceof Error ? error.message : String(error) },
        "Could not remove an obsolete initial-generation checkpoint",
      );
    }
  }

  async #completeKeyword(
    keyword: SheetRecord,
    articleId: string,
    articleStatus: Article["status"] = "needs_review",
  ): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const now = new Date().toISOString();
    const eventId = stableEventId("generated", articleId);
    await this.store.patchKeywordAndAppendEvent(
      keywordId,
      {
        status: "used",
        used_at: now,
        article_id: articleId,
        updated_at: now,
      },
      {
        event_id: eventId,
        article_id: articleId,
        event_type: "generated",
        from_status: "generating",
        to_status: articleStatus,
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message: `Generated from keyword ${keywordId}`,
        payload_json: JSON.stringify({
          keyword_id: keywordId,
          model: this.config.openAiModel,
          article_status: articleStatus,
        }),
        created_at: now,
      },
    );
  }

  async #failKeyword(
    keyword: SheetRecord,
    error: unknown,
    stage: GenerationFailureStage,
  ): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const reason = classifyOpenAiApiError(error);
    this.logger.error({ keywordId, err: message }, "Article generation failed");
    const now = new Date().toISOString();
    if (!articleId) throw new Error(`Keyword ${keywordId} has no reserved article ID`);
    const failedFromStatus = (await this.store.findArticle(articleId))?.status ||
      stringCell(keyword.status) || CLAIMED_STATUS;
    const failureEvents = await this.store.listEvents(articleId);
    const requestEvent = latestEvent(
      failureEvents,
      (event) =>
        stringCell(event.event_type) === "generation_requested" &&
        stringCell(event.actor_type) === "telegram_user" &&
        stringCell(event.provider) === "telegram",
    );
    const requestId = stringCell(requestEvent?.provider_object_id) || "scheduled";
    const attemptEvent = latestEvent(
      failureEvents,
      (event) => stringCell(event.event_type) === "generation_attempt_started",
    );
    const eventId = stableEventId(
      "generation_failed",
      `${articleId}:${requestId}:${stage}:${message}`,
    );
    const httpStatus = typeof (error as { status?: unknown })?.status === "number"
      ? Number((error as { status: number }).status)
      : undefined;
    const retryProof = reason &&
        stage === "article_generation" &&
        requestEvent &&
        attemptEvent &&
        httpStatus !== undefined
      ? openAiFailureRetryProof(
          this.config.telegramBotToken,
          eventId,
          articleId,
          keywordId,
          stringCell(requestEvent.event_id),
          requestId,
          stringCell(attemptEvent.event_id),
          stage,
          reason,
          httpStatus,
        )
      : undefined;
    await this.store.patchKeywordAndAppendEvent(
      keywordId,
      {
        status: "paused",
        research_notes: appendNote(stringCell(keyword.research_notes), `Generation failed: ${message}`),
        updated_at: now,
      },
      {
        event_id: eventId,
        article_id: articleId,
        event_type: "generation_failed",
        from_status: failedFromStatus,
        to_status: "paused",
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message,
        payload_json: JSON.stringify({
          keyword_id: keywordId,
          stage,
          request_id: requestId,
          ...(requestEvent ? { request_event_id: stringCell(requestEvent.event_id) } : {}),
          ...(attemptEvent ? { attempt_event_id: stringCell(attemptEvent.event_id) } : {}),
          ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
          ...(reason ? { reason } : {}),
          ...(retryProof ? { retry_proof: retryProof } : {}),
        }),
        created_at: now,
      },
    );
    await this.#markArticleGenerationFailure(articleId, error);
  }

  async #blockKeyword(keyword: SheetRecord, reason: string): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    if (!articleId) throw new Error(`Keyword ${keywordId} has no reserved article ID`);
    const now = new Date().toISOString();
    const requestEvent = latestEvent(
      await this.store.listEvents(articleId),
      (event) =>
        stringCell(event.event_type) === "generation_requested" &&
        stringCell(event.actor_type) === "telegram_user" &&
        stringCell(event.provider) === "telegram",
    );
    const requestId = stringCell(requestEvent?.provider_object_id) || "scheduled";
    const eventId = stableEventId("generation_blocked", `${articleId}:${requestId}:${reason}`);
    const retryProof = requestEvent
      ? manualBlockRetryProof(
          this.config.telegramBotToken,
          eventId,
          articleId,
          keywordId,
          stringCell(requestEvent.event_id),
          requestId,
          reason,
        )
      : undefined;
    await this.store.patchKeywordAndAppendEvent(
      keywordId,
      {
        status: "paused",
        research_notes: appendNote(stringCell(keyword.research_notes), `Generation blocked: ${reason}`),
        updated_at: now,
      },
      {
        event_id: eventId,
        article_id: articleId,
        event_type: "generation_blocked",
        from_status: CLAIMED_STATUS,
        to_status: "paused",
        actor_type: "system",
        actor_id: "generator",
        provider: "system",
        message: reason,
        payload_json: JSON.stringify({
          keyword_id: keywordId,
          reason,
          request_id: requestId,
          ...(requestEvent ? { request_event_id: stringCell(requestEvent.event_id) } : {}),
          ...(retryProof ? { retry_proof: retryProof } : {}),
        }),
        created_at: now,
      },
    );
  }

  async #hasManualRequestEvent(keyword: SheetRecord): Promise<boolean> {
    return Boolean(await this.#manualRequestEvent(keyword));
  }

  async #hasValidManualRequest(keyword: SheetRecord): Promise<boolean> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    const locale = stringCell(keyword.locale).toLowerCase();
    const normalizedKeyword = normalizeManualKeyword(stringCell(keyword.primary_keyword));
    if (!keywordId || !articleId || !locale || !normalizedKeyword) return false;

    const event = await this.#manualRequestEvent(keyword);
    if (!event) return false;
    const providerObjectId = stringCell(event.provider_object_id);

    try {
      const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
      const isSheetQueueRequest = payload.request_kind === "sheet_queue";
      const claimedRow = isSheetQueueRequest && Number.isInteger(payload.row_number)
        ? Number(payload.row_number)
        : undefined;
      if (
        payload.keyword_id !== keywordId ||
        (isSheetQueueRequest && payload.article_id !== articleId) ||
        payload.locale !== locale ||
        payload.keyword !== normalizedKeyword ||
        (isSheetQueueRequest && (!claimedRow || claimedRow < 2)) ||
        typeof payload.signature !== "string"
      ) {
        return false;
      }
      const expected = manualRequestSignature(
        this.config.telegramBotToken,
        providerObjectId,
        keywordId,
        articleId,
        locale,
        normalizedKeyword,
        stringCell(event.actor_id),
        claimedRow,
      );
      return signaturesEqual(payload.signature, expected);
    } catch {
      return false;
    }
  }

  async #manualRequestEvent(keyword: SheetRecord): Promise<SheetRecord | undefined> {
    const articleId = stringCell(keyword.article_id);
    if (!articleId) return undefined;
    const events = await this.store.listEvents(articleId);
    return latestEvent(
      events,
      (candidate) =>
        stringCell(candidate.event_type) === "generation_requested" &&
        stringCell(candidate.actor_type) === "telegram_user" &&
        stringCell(candidate.provider) === "telegram" &&
        Boolean(stringCell(candidate.provider_object_id)),
    );
  }

  async #evaluateGeneratedCandidate(
    candidate: Article,
    modelBlockers: GeneratedQaBlockerCode[],
  ): Promise<{ blockers: string[]; manualRequired: boolean }> {
    const deterministic = await this.qualityGate.evaluate({
      ...candidate,
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
    });
    return {
      blockers: [...new Set([...deterministic.blockers, ...modelBlockers])].sort(),
      manualRequired: modelBlockers.some(isSemanticGeneratedQaBlocker),
    };
  }

  async #prepareHeroImage(article: Article): Promise<Record<string, CellValue>> {
    if (!this.heroImages) return {};
    try {
      const image = await this.heroImages.ensureForArticle(article);
      return {
        feature_image_url: image.url,
        feature_image_alt: image.alt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Hero image generation/upload failed; article was not published: ${detail}`);
    }
  }
}

function generatedArticleFields(generated: GeneratedArticle): Record<string, CellValue> {
  return {
    title: generated.title,
    slug: generated.slug,
    excerpt: generated.excerpt,
    seo_title: generated.seo_title,
    meta_description: generated.meta_description,
    body_markdown: generated.body_markdown,
    tags: generated.tags.join(","),
    source_urls: generated.source_urls.join("\n"),
    internal_links: generated.internal_links.join("\n"),
    quality_score: generated.quality_score,
  };
}

function providerCommandId(provider: "telegram" | "system", providerObjectId: string): string {
  return `${provider}:${providerObjectId}`;
}

function requestedEvent(
  request: ManualGenerationRequest,
  keywordId: string,
  articleId: string,
  keyword: string,
  locale: string,
  keywordRow: number,
  createdAt: string,
  signingSecret: string,
  fromStatus: "ready" | "paused" = "ready",
  isRecovery = fromStatus === "paused",
): AuditEvent {
  const actorId = String(request.actorId);
  const signature = manualRequestSignature(
    signingSecret,
    request.providerObjectId,
    keywordId,
    articleId,
    locale,
    keyword,
    actorId,
    keywordRow,
  );
  return {
    event_id: stableEventId("generation_requested", request.providerObjectId),
    article_id: articleId,
    event_type: "generation_requested",
    from_status: fromStatus,
    to_status: CLAIMED_STATUS,
    actor_type: "telegram_user",
    actor_id: actorId,
    provider: "telegram",
    provider_object_id: request.providerObjectId,
    message: `${isRecovery ? "Recovery" : "Next-keyword"} generation requested for ${keyword}`,
    payload_json: JSON.stringify({
      request_kind: "sheet_queue",
      keyword_id: keywordId,
      article_id: articleId,
      row_number: keywordRow,
      locale,
      keyword,
      signature,
    }),
    created_at: createdAt,
  };
}

function manualRequestSignature(
  secret: string,
  providerObjectId: string,
  keywordId: string,
  articleId: string,
  locale: string,
  keyword: string,
  actorId: string,
  keywordRow?: number,
): string {
  const payload = keywordRow === undefined
    ? ["v1", providerObjectId, keywordId, articleId, locale, keyword, actorId]
    : ["v2", "sheet_queue", providerObjectId, keywordId, articleId, String(keywordRow), locale, keyword, actorId];
  return createHmac("sha256", secret).update(payload.join("\n")).digest("hex");
}

function signaturesEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(actual)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function manualGenerationIsEnabled(
  config: Pick<AppConfig, "allowTelegramGeneration">,
  settings: Map<string, CellValue>,
): boolean {
  return config.allowTelegramGeneration && booleanCell(settings.get("telegram_generation_enabled"));
}

export function normalizeManualKeyword(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function manualRequestArticleId(providerObjectId: string): string {
  const hash = createHash("sha256").update(providerObjectId).digest("hex").slice(0, 12).toUpperCase();
  return `SEO-TG-${hash}`;
}

type ManualGenerationBlockedResult = Extract<ManualGenerationResult, { outcome: "blocked" }>;

function blockedForKeyword(
  reason: ManualGenerationBlockReason,
  keyword: SheetRecord,
  details: Omit<
    ManualGenerationBlockedResult,
    "outcome" | "reason" | "rowNumber" | "keywordId" | "locale"
  > = {},
): ManualGenerationBlockedResult {
  const keywordId = stringCell(keyword.keyword_id);
  const locale = stringCell(keyword.locale).toLowerCase();
  return {
    outcome: "blocked",
    reason,
    rowNumber: keyword.__rowNumber,
    ...(keywordId ? { keywordId } : {}),
    ...(locale ? { locale } : {}),
    ...details,
  };
}

function resultForExistingKeyword(keyword: SheetRecord): Exclude<ManualGenerationResult, { outcome: "blocked" }> {
  const status = stringCell(keyword.status);
  const outcome = status === "used" ? "already_generated" : status === "paused" ? "previous_failed" : "already_queued";
  return {
    outcome,
    keywordId: stringCell(keyword.keyword_id),
    articleId: stringCell(keyword.article_id),
    locale: stringCell(keyword.locale).toLowerCase(),
    keyword: normalizeManualKeyword(stringCell(keyword.primary_keyword)),
    rowNumber: keyword.__rowNumber,
  };
}

function latestEvent(
  events: SheetRecord[],
  predicate: (event: SheetRecord) => boolean,
): SheetRecord | undefined {
  return events
    .filter(predicate)
    .sort((left, right) =>
      right.__rowNumber - left.__rowNumber ||
      stringCell(right.created_at).localeCompare(stringCell(left.created_at)),
    )[0];
}

function eventIdIsUnique(events: SheetRecord[], event: SheetRecord): boolean {
  const eventId = stringCell(event.event_id);
  return Boolean(eventId) && events.filter((candidate) => stringCell(candidate.event_id) === eventId).length === 1;
}

function storedOpenAiFailureReason(
  event: SheetRecord,
  keyword: SheetRecord,
  request: SheetRecord | undefined,
  attempt: SheetRecord | undefined,
  signingSecret: string,
): OpenAiFailureReason | undefined {
  if (
    stringCell(event.event_type) !== "generation_failed" ||
    stringCell(event.provider).toLowerCase() !== "openai" ||
    stringCell(event.actor_type) !== "system" ||
    stringCell(event.actor_id) !== "generator" ||
    stringCell(event.to_status) !== "paused"
  ) {
    return undefined;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
    if (payload.stage !== "article_generation") return undefined;
    if (payload.keyword_id !== stringCell(keyword.keyword_id)) return undefined;
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    if (OPENAI_FAILURE_REASONS.includes(reason as OpenAiFailureReason)) {
      if (!request || !attempt) return undefined;
      const typedReason = reason as OpenAiFailureReason;
      const httpStatus = Number(payload.http_status);
      if (!openAiFailureStatusMatchesReason(httpStatus, typedReason)) return undefined;
      if (
        payload.request_id !== stringCell(request.provider_object_id) ||
        payload.request_event_id !== stringCell(request.event_id) ||
        payload.attempt_event_id !== stringCell(attempt.event_id) ||
        typeof payload.retry_proof !== "string"
      ) {
        return undefined;
      }
      const expected = openAiFailureRetryProof(
        signingSecret,
        stringCell(event.event_id),
        stringCell(keyword.article_id),
        stringCell(keyword.keyword_id),
        stringCell(request.event_id),
        stringCell(request.provider_object_id),
        stringCell(attempt.event_id),
        "article_generation",
        typedReason,
        httpStatus,
      );
      return signaturesEqual(payload.retry_proof, expected) ? typedReason : undefined;
    }
  } catch {
    return undefined;
  }
  const message = stringCell(event.message).trim();
  if (
    stringCell(keyword.keyword_id) === "KW-CLIENT-006" &&
    stringCell(keyword.article_id) === "SEO-TG-4C9E16E19436" &&
    stringCell(request?.event_id) === "evt-generation_requested-6edea860bb804cd700482de9" &&
    stringCell(attempt?.event_id) === "evt-generation_attempt_started-797c1815321f60bfa6e57b2e" &&
    stringCell(event.event_id) === "evt-generation_failed-731cd5df27d4390fcf50c865" &&
    message ===
      "429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/."
  ) {
    return "openai_credit_balance_exhausted";
  }
  return undefined;
}

function isExplicitlyRecoverableStop(
  event: SheetRecord,
  keyword: SheetRecord,
  request: SheetRecord | undefined,
  attempt: SheetRecord | undefined,
  signingSecret: string,
): boolean {
  if (storedOpenAiFailureReason(event, keyword, request, attempt, signingSecret)) return true;
  if (
    stringCell(event.event_type) !== "generation_blocked" ||
    stringCell(event.actor_type) !== "system" ||
    stringCell(event.actor_id) !== "generator" ||
    stringCell(event.provider) !== "system" ||
    stringCell(event.to_status) !== "paused" ||
    !request
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
    if (payload.keyword_id !== stringCell(keyword.keyword_id)) return false;
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    if (!["ru_disabled", "locale_disabled", "no_internal_links"].includes(reason)) return false;
    if (
      payload.request_id !== stringCell(request.provider_object_id) ||
      payload.request_event_id !== stringCell(request.event_id) ||
      typeof payload.retry_proof !== "string"
    ) {
      return false;
    }
    const expected = manualBlockRetryProof(
      signingSecret,
      stringCell(event.event_id),
      stringCell(keyword.article_id),
      stringCell(keyword.keyword_id),
      stringCell(request.event_id),
      stringCell(request.provider_object_id),
      reason,
    );
    return signaturesEqual(payload.retry_proof, expected);
  } catch {
    return false;
  }
}

function openAiFailureStatusMatchesReason(status: number, reason: OpenAiFailureReason): boolean {
  return reason === "openai_authentication_failed"
    ? status === 401 || status === 403
    : status === 429;
}

function openAiFailureRetryProof(
  secret: string,
  failureEventId: string,
  articleId: string,
  keywordId: string,
  requestEventId: string,
  requestProviderObjectId: string,
  attemptEventId: string,
  stage: GenerationFailureStage,
  reason: OpenAiFailureReason,
  httpStatus: number,
): string {
  return createHmac("sha256", secret).update([
    "v1",
    failureEventId,
    articleId,
    keywordId,
    requestEventId,
    requestProviderObjectId,
    attemptEventId,
    stage,
    reason,
    String(httpStatus),
  ].join("\n")).digest("hex");
}

function manualBlockRetryProof(
  secret: string,
  blockEventId: string,
  articleId: string,
  keywordId: string,
  requestEventId: string,
  requestProviderObjectId: string,
  reason: string,
): string {
  return createHmac("sha256", secret).update([
    "v1",
    blockEventId,
    articleId,
    keywordId,
    requestEventId,
    requestProviderObjectId,
    reason,
  ].join("\n")).digest("hex");
}

function isDue(keyword: SheetRecord, timeZone: string): boolean {
  const raw = keyword.planned_publish_at;
  if (raw === undefined || raw === null || raw === "") return true;
  const date = dateCell(raw, timeZone);
  return Boolean(date && date.getTime() <= Date.now());
}

function createArticleId(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `SEO-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function stableEventId(kind: string, source: string): string {
  const hash = createHash("sha256").update(`${kind}:${source}`).digest("hex").slice(0, 24);
  return `evt-${kind}-${hash}`;
}

function appendNote(existing: string, note: string): string {
  return [existing, `[${new Date().toISOString()}] ${note}`].filter(Boolean).join("\n").slice(-2_000);
}
