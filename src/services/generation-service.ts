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
  isSemanticGeneratedQaBlocker,
  type GeneratedQaBlockerCode,
} from "../domain/quality.js";
import type { GeneratedArticle, OpenAiArticleGenerator } from "../generation/openai-generator.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import type { AuditEvent, GoogleSheetsStore } from "../sheets/google-sheets.js";
import type { HeroImageService } from "./hero-image-service.js";
import { QualityGate } from "./quality-gate.js";

const CLAIMED_STATUS = "assigned";

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
  | "generation_in_progress";

export type InvalidKeywordField = "keyword_id" | "locale" | "primary_keyword" | "article_id";

export type ManualGenerationRequest = {
  actorId: number;
  actorName: string;
  providerObjectId: string;
};

export type ManualGenerationResult =
  | {
      outcome: "queued" | "already_queued" | "already_generated" | "previous_failed";
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
};

export type RegenerationResult =
  | { outcome: "regenerated" | "already_regenerated"; article: Article }
  | {
      outcome: "blocked";
      reason:
        | "generator_not_configured"
        | "manual_generation_disabled"
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
    const articleId = manualRequestArticleId(request.providerObjectId);
    return this.#requestMutex.runExclusive("keyword-claim", async () => {
      const allKeywords = await this.store.listKeywords(undefined, { includeIncomplete: true });
      const existing = allKeywords.find(
        (candidate) => stringCell(candidate.article_id).toLowerCase() === articleId.toLowerCase(),
      );
      if (existing) {
        if (!(await this.#hasValidManualRequest(existing))) {
          return blockedForKeyword("request_conflict", existing, {
            ...(stringCell(existing.article_id) ? { articleId: stringCell(existing.article_id) } : {}),
          });
        }
        return resultForExistingKeyword(existing);
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

      const keyword = allKeywords
        .filter((candidate) => stringCell(candidate.status) === "ready")
        .sort((left, right) => left.__rowNumber - right.__rowNumber)[0];
      if (!keyword) return { outcome: "blocked", reason: "no_ready_keywords" };

      const keywordId = stringCell(keyword.keyword_id);
      const normalizedKeyword = normalizeManualKeyword(stringCell(keyword.primary_keyword));
      const locale = stringCell(keyword.locale).toLowerCase();
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
      if (stringCell(keyword.article_id)) invalidFields.push("article_id");
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
        ),
        {
          status: "ready",
          article_id: "",
          locale: keyword.locale ?? "",
          primary_keyword: keyword.primary_keyword ?? "",
        },
      );
      if (claimed === false) {
        return blockedForKeyword("keyword_row_changed", keyword);
      }
      return {
        outcome: "queued",
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
      if (!manualGenerationIsEnabled(this.config, settings)) {
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
      const currentQuality = await this.qualityGate.evaluate({
        ...article,
        manual_required: false,
      });
      const generated = await this.generator!.generate({
        keyword: {
          ...article,
          topic_angle: stringCell(article.topic) || stringCell(article.primary_keyword),
          research_notes: stringCell(request.feedback),
        },
        guardrails,
        allowedLinks,
        targetWords: numberCell(settings.get("default_article_length_words")) || 1_200,
        revision: {
          article,
          ...(stringCell(request.feedback) ? { feedback: stringCell(request.feedback) } : {}),
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
      const revisionCount = numberCell(article.revision_count) + 1;
      const updated = await this.store.patchArticleAndAppendEvent(
        article.article_id,
        {
          ...generatedFields,
          ...heroImageFields,
          status: "needs_review",
          qa_status: quality.blockers.length === 0 ? "pass" : "fail",
          qa_blockers: quality.blockers.join(","),
          manual_required: quality.manualRequired,
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
          ...(stringCell(request.feedback) ? { feedback: stringCell(request.feedback) } : {}),
          updated_at: now,
        },
        {
          event_id: stableEventId("regenerated", request.providerObjectId),
          article_id: article.article_id,
          event_type: "regenerated",
          from_status: article.status,
          to_status: "needs_review",
          actor_type: request.actorType ?? "telegram_user",
          actor_id: String(request.actorId),
          provider,
          provider_object_id: commandId,
          message: `Regenerated by ${request.actorName}`,
          payload_json: JSON.stringify({
            previous_hash: articleContentHash(article),
            revision_count: revisionCount,
            feedback: stringCell(request.feedback) || null,
            model: this.config.openAiModel,
            qa_blockers: quality.blockers,
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

  async #generateKeyword(keyword: SheetRecord, settings: Map<string, CellValue>): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id) || createArticleId();
    const existingArticle = await this.store.findArticle(articleId);
    if (existingArticle) {
      await this.#completeKeyword(keyword, articleId);
      return;
    }
    const priorEvents = await this.store.listEvents(articleId);
    if (
      priorEvents.some((event) =>
        ["generation_failed", "generation_blocked"].includes(stringCell(event.event_type)),
      )
    ) {
      await this.store.patchKeyword(keywordId, {
        status: "paused",
        updated_at: new Date().toISOString(),
      });
      return;
    }

    let generated;
    try {
      const [guardrails, links] = await Promise.all([
        this.store.listGuardrails(),
        this.store.listLinks(),
      ]);
      const targetWords = numberCell(settings.get("default_article_length_words")) || 1_200;
      generated = await this.generator!.generate({
        keyword,
        guardrails,
        allowedLinks: links.filter(
          (link) => stringCell(link.environment) === this.config.targetEnvironment,
        ),
        targetWords,
      });
    } catch (error) {
      await this.#failKeyword(keyword, error);
      return;
    }

    const now = new Date().toISOString();
    const generatedFields = generatedArticleFields(generated);
    const values: Record<string, CellValue> = {
      article_id: articleId,
      keyword_id: keywordId,
      translation_group_id: `TG-${keywordId}`,
      locale: stringCell(keyword.locale),
      status: "needs_review",
      primary_keyword: stringCell(keyword.primary_keyword),
      secondary_keywords: stringCell(keyword.secondary_keywords),
      search_intent: stringCell(keyword.search_intent),
      article_type: stringCell(keyword.article_type),
      topic: stringCell(keyword.topic_angle) || stringCell(keyword.primary_keyword),
      ...generatedFields,
      scheduled_publish_at: keyword.planned_publish_at ?? "",
      quality_score: generated.quality_score,
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      revision_count: 0,
      created_at: now,
      updated_at: now,
    };
    try {
      Object.assign(
        values,
        await this.#prepareHeroImage({ ...values, __rowNumber: 0 } as Article),
      );
    } catch (error) {
      await this.#failKeyword(keyword, error);
      return;
    }
    try {
      const quality = await this.#evaluateGeneratedCandidate(
        { ...values, __rowNumber: 0 } as Article,
        generated.qa_blockers,
      );
      values.qa_status = quality.blockers.length === 0 ? "pass" : "fail";
      values.qa_blockers = quality.blockers.join(",");
      values.manual_required = quality.manualRequired;
    } catch (error) {
      await this.#failKeyword(keyword, error);
      return;
    }
    values.content_hash = articleContentHash({ ...values, __rowNumber: 0 } as SheetRecord);

    try {
      await this.store.appendArticle(values);
    } catch (error) {
      const recovered = await this.store.findArticle(articleId);
      if (!recovered) {
        await this.#failKeyword(keyword, error);
        return;
      }
      this.logger.warn({ keywordId, articleId }, "Article append response failed but the article exists");
    }
    await this.#completeKeyword(keyword, articleId);
  }

  async #completeKeyword(keyword: SheetRecord, articleId: string): Promise<void> {
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
        from_status: CLAIMED_STATUS,
        to_status: "needs_review",
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message: `Generated from keyword ${keywordId}`,
        payload_json: JSON.stringify({ keyword_id: keywordId, model: this.config.openAiModel }),
        created_at: now,
      },
    );
  }

  async #failKeyword(keyword: SheetRecord, error: unknown): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.logger.error({ keywordId, err: message }, "Article generation failed");
    const now = new Date().toISOString();
    const eventId = stableEventId("generation_failed", `${articleId}:${message}`);
    if (!articleId) throw new Error(`Keyword ${keywordId} has no reserved article ID`);
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
        from_status: CLAIMED_STATUS,
        to_status: "paused",
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message,
        payload_json: JSON.stringify({ keyword_id: keywordId }),
        created_at: now,
      },
    );
  }

  async #blockKeyword(keyword: SheetRecord, reason: string): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    if (!articleId) throw new Error(`Keyword ${keywordId} has no reserved article ID`);
    const now = new Date().toISOString();
    await this.store.patchKeywordAndAppendEvent(
      keywordId,
      {
        status: "paused",
        research_notes: appendNote(stringCell(keyword.research_notes), `Generation blocked: ${reason}`),
        updated_at: now,
      },
      {
        event_id: stableEventId("generation_blocked", `${articleId}:${reason}`),
        article_id: articleId,
        event_type: "generation_blocked",
        from_status: CLAIMED_STATUS,
        to_status: "paused",
        actor_type: "system",
        actor_id: "generator",
        provider: "system",
        message: reason,
        payload_json: JSON.stringify({ keyword_id: keywordId, reason }),
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
    return events.find(
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
    from_status: "ready",
    to_status: CLAIMED_STATUS,
    actor_type: "telegram_user",
    actor_id: actorId,
    provider: "telegram",
    provider_object_id: request.providerObjectId,
    message: `Next-keyword generation requested for ${keyword}`,
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
