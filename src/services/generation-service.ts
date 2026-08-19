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
import { QualityGate } from "./quality-gate.js";

const MANUAL_SOURCE_PREFIX = "telegram_manual:";
const CLAIMED_STATUS = "assigned";

export type ManualGenerationBlockReason =
  | "generator_not_configured"
  | "manual_generation_disabled"
  | "invalid_keyword"
  | "locale_disabled"
  | "ru_disabled"
  | "no_internal_links"
  | "queue_full";

export type ManualGenerationRequest = {
  keyword: string;
  locale?: string;
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
    }
  | {
      outcome: "blocked";
      reason: ManualGenerationBlockReason;
      locale?: string;
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
  ) {}

  /** Scheduled queue. The Sheet generation_enabled flag is an absolute gate. */
  async runOnce(): Promise<void> {
    await this.#runQueue("scheduled");
  }

  /** Telegram queue. It has separate server and Sheet kill switches. */
  async runManualOnce(): Promise<void> {
    await this.#runQueue("manual");
  }

  async requestManualGeneration(request: ManualGenerationRequest): Promise<ManualGenerationResult> {
    if (!this.generator) return { outcome: "blocked", reason: "generator_not_configured" };

    const keyword = normalizeManualKeyword(request.keyword);
    if (
      keyword.length < 2 ||
      keyword.length > 200 ||
      /[\u0000-\u001F\u007F]/u.test(keyword)
    ) {
      return { outcome: "blocked", reason: "invalid_keyword" };
    }

    const settings = await this.store.getSettings();
    if (!manualGenerationIsEnabled(this.config, settings)) {
      return { outcome: "blocked", reason: "manual_generation_disabled" };
    }

    const locale = (stringCell(request.locale) || stringCell(settings.get("default_locale"))).toLowerCase();
    const enabledLocales = new Set(
      parseListCell(settings.get("enabled_locales")).map((value) => value.toLowerCase()),
    );
    if (locale === "ru" && !booleanCell(settings.get("ru_enabled"))) {
      return { outcome: "blocked", reason: "ru_disabled", locale };
    }
    if (!locale || !enabledLocales.has(locale)) {
      return { outcome: "blocked", reason: "locale_disabled", ...(locale ? { locale } : {}) };
    }

    const links = await this.store.listLinks();
    const hasInternalLink = links.some(
      (link) =>
        stringCell(link.environment) === this.config.targetEnvironment &&
        stringCell(link.status) === "active" &&
        booleanCell(link.allow_internal_link) &&
        ["all", locale].includes(stringCell(link.locale)),
    );
    if (!hasInternalLink) return { outcome: "blocked", reason: "no_internal_links", locale };

    const ids = manualRequestIds(request.providerObjectId);
    return this.#requestMutex.runExclusive("manual-generation-request", async () => {
      const exact = await this.store.findKeyword(ids.keywordId);
      if (exact) {
        const articleId = stringCell(exact.article_id) || ids.articleId;
        await this.#ensureRequestedEvent(exact, request, keyword, locale, articleId);
        return resultForExistingKeyword(exact, ids.keywordId, articleId, locale, keyword);
      }

      const keywordKey = normalizeManualKeyword(keyword).toLowerCase();
      const allKeywords = await this.store.listKeywords();
      const duplicateCandidates = allKeywords.filter(
        (candidate) =>
          stringCell(candidate.source).startsWith(MANUAL_SOURCE_PREFIX) &&
          stringCell(candidate.locale).toLowerCase() === locale &&
          normalizeManualKeyword(stringCell(candidate.primary_keyword)).toLowerCase() === keywordKey &&
          ["ready", CLAIMED_STATUS, "generating", "used"].includes(stringCell(candidate.status)),
      );
      let duplicate: SheetRecord | undefined;
      for (const candidate of duplicateCandidates) {
        if (await this.#hasValidManualRequest(candidate)) {
          duplicate = candidate;
          break;
        }
      }
      if (duplicate) {
        const duplicateKeywordId = stringCell(duplicate.keyword_id);
        const duplicateArticleId = stringCell(duplicate.article_id) || ids.articleId;
        return resultForExistingKeyword(
          duplicate,
          duplicateKeywordId,
          duplicateArticleId,
          locale,
          keyword,
        );
      }

      const queueLimit = Math.max(1, numberCell(settings.get("telegram_generation_queue_limit")) || 3);
      const activeManualRequests = allKeywords.filter(
        (candidate) =>
          stringCell(candidate.source).startsWith(MANUAL_SOURCE_PREFIX) &&
          ["ready", CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status)),
      );
      const authorizedActiveRequests = (
        await Promise.all(activeManualRequests.map((candidate) => this.#hasValidManualRequest(candidate)))
      ).filter(Boolean).length;
      if (authorizedActiveRequests >= queueLimit) {
        return { outcome: "blocked", reason: "queue_full", locale };
      }

      const now = new Date().toISOString();
      const source = `${MANUAL_SOURCE_PREFIX}${request.providerObjectId}`;
      const keywordValues: Record<string, CellValue> = {
        keyword_id: ids.keywordId,
        locale,
        primary_keyword: keyword,
        secondary_keywords: "",
        cluster: "telegram_manual",
        geo_target: "Belgrade, Serbia",
        search_intent: "informational",
        article_type: "guide",
        priority: 100,
        status: CLAIMED_STATUS,
        topic_angle: keyword,
        research_notes: `Requested in Telegram by ${request.actorName || request.actorId}`,
        planned_publish_at: "",
        used_at: "",
        article_id: ids.articleId,
        source,
        search_volume: "",
        difficulty: "",
        created_at: now,
        updated_at: now,
      };
      await this.store.appendKeywordAndEvent(
        keywordValues,
        requestedEvent(
          request,
          ids.keywordId,
          ids.articleId,
          keyword,
          locale,
          now,
          this.config.telegramBotToken,
        ),
      );
      return {
        outcome: "queued",
        keywordId: ids.keywordId,
        articleId: ids.articleId,
        locale,
        keyword,
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
      const candidate = {
        ...article,
        ...generatedFields,
        status: "needs_review",
        qa_status: "pass",
        qa_blockers: "",
        manual_required: false,
        updated_at: now,
      } as Article;
      const quality = await this.#evaluateGeneratedCandidate(candidate, generated.qa_blockers);
      const revisionCount = numberCell(article.revision_count) + 1;
      const updated = await this.store.patchArticleAndAppendEvent(
        article.article_id,
        {
          ...generatedFields,
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

  async #runQueue(queue: "manual" | "scheduled"): Promise<void> {
    if (this.#running || !this.generator) return;
    this.#running = true;
    try {
      const settings = await this.store.getSettings();
      if (queue === "manual") {
        if (!manualGenerationIsEnabled(this.config, settings)) return;
      } else if (!booleanCell(settings.get("generation_enabled") ?? false)) {
        return;
      }

      const statuses =
        queue === "manual"
          ? ["ready", CLAIMED_STATUS, "generating"]
          : ["ready", CLAIMED_STATUS, "generating"];
      const keywords = (await this.store.listKeywords(statuses))
        .filter((candidate) => {
          const isManual = stringCell(candidate.source).startsWith(MANUAL_SOURCE_PREFIX);
          return queue === "manual" ? isManual : !isManual;
        })
        .filter((candidate) =>
          [CLAIMED_STATUS, "generating"].includes(stringCell(candidate.status))
            ? true
            : isDue(candidate, stringCell(settings.get("timezone")) || "Europe/Belgrade"),
        )
        .sort((left, right) => {
          const recoveryOrder =
            Number([CLAIMED_STATUS, "generating"].includes(stringCell(right.status))) -
            Number([CLAIMED_STATUS, "generating"].includes(stringCell(left.status)));
          return recoveryOrder || numberCell(right.priority) - numberCell(left.priority);
        });
      let keyword = keywords[0];
      if (!keyword) return;

      if (stringCell(keyword.status) !== CLAIMED_STATUS || !stringCell(keyword.article_id)) {
        const articleId = stringCell(keyword.article_id) || createArticleId();
        const claimedAt = new Date().toISOString();
        await this.store.patchKeyword(stringCell(keyword.keyword_id), {
          status: CLAIMED_STATUS,
          article_id: articleId,
          updated_at: claimedAt,
        });
        keyword = { ...keyword, status: CLAIMED_STATUS, article_id: articleId, updated_at: claimedAt };
      }
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
        stringCell(link.environment) === this.config.targetEnvironment &&
        stringCell(link.status) === "active" &&
        booleanCell(link.allow_internal_link) &&
        ["all", locale].includes(stringCell(link.locale)),
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

  async #ensureRequestedEvent(
    keyword: SheetRecord,
    request: ManualGenerationRequest,
    normalizedKeyword: string,
    locale: string,
    articleId: string,
  ): Promise<void> {
    if (await this.#hasValidManualRequest(keyword)) return;
    const event = requestedEvent(
      request,
      stringCell(keyword.keyword_id),
      articleId,
      normalizedKeyword,
      locale,
      new Date().toISOString(),
      this.config.telegramBotToken,
    );
    await this.store.appendEvent(event);
  }

  async #hasValidManualRequest(keyword: SheetRecord): Promise<boolean> {
    const source = stringCell(keyword.source);
    const providerObjectId = source.startsWith(MANUAL_SOURCE_PREFIX)
      ? source.slice(MANUAL_SOURCE_PREFIX.length)
      : "";
    const keywordId = stringCell(keyword.keyword_id);
    const articleId = stringCell(keyword.article_id);
    const locale = stringCell(keyword.locale).toLowerCase();
    const normalizedKeyword = normalizeManualKeyword(stringCell(keyword.primary_keyword));
    if (!providerObjectId || !keywordId || !articleId || !locale || !normalizedKeyword) return false;

    const events = await this.store.listEvents(articleId);
    const event = events.find(
      (candidate) =>
        stringCell(candidate.event_id) === stableEventId("generation_requested", providerObjectId) &&
        stringCell(candidate.event_type) === "generation_requested" &&
        stringCell(candidate.actor_type) === "telegram_user" &&
        stringCell(candidate.provider) === "telegram" &&
        stringCell(candidate.provider_object_id) === providerObjectId,
    );
    if (!event) return false;

    try {
      const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
      if (
        payload.keyword_id !== keywordId ||
        payload.locale !== locale ||
        payload.keyword !== normalizedKeyword ||
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
      );
      return signaturesEqual(payload.signature, expected);
    } catch {
      return false;
    }
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
  );
  return {
    event_id: stableEventId("generation_requested", request.providerObjectId),
    article_id: articleId,
    event_type: "generation_requested",
    from_status: "",
    to_status: CLAIMED_STATUS,
    actor_type: "telegram_user",
    actor_id: actorId,
    provider: "telegram",
    provider_object_id: request.providerObjectId,
    message: `Manual generation requested for ${keyword}`,
    payload_json: JSON.stringify({ keyword_id: keywordId, locale, keyword, signature }),
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
): string {
  const payload = ["v1", providerObjectId, keywordId, articleId, locale, keyword, actorId].join("\n");
  return createHmac("sha256", secret).update(payload).digest("hex");
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

export function manualRequestIds(providerObjectId: string): { keywordId: string; articleId: string } {
  const hash = createHash("sha256").update(providerObjectId).digest("hex").slice(0, 12).toUpperCase();
  return { keywordId: `KW-TG-${hash}`, articleId: `SEO-TG-${hash}` };
}

function resultForExistingKeyword(
  keyword: SheetRecord,
  keywordId: string,
  articleId: string,
  locale: string,
  normalizedKeyword: string,
): Exclude<ManualGenerationResult, { outcome: "blocked" }> {
  const status = stringCell(keyword.status);
  const outcome = status === "used" ? "already_generated" : status === "paused" ? "previous_failed" : "already_queued";
  return { outcome, keywordId, articleId, locale, keyword: normalizedKeyword };
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
