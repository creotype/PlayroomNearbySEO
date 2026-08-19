import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { articleContentHash, booleanCell, dateCell, numberCell, stringCell, type SheetRecord } from "../domain/article.js";
import type { OpenAiArticleGenerator } from "../generation/openai-generator.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";

export class GenerationService {
  #running = false;

  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly generator: OpenAiArticleGenerator | undefined,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    if (this.#running || !this.generator) return;
    const settings = await this.store.getSettings();
    if (!booleanCell(settings.get("generation_enabled") ?? false)) return;
    this.#running = true;
    try {
      const keywords = (await this.store.listKeywords(["ready"]))
        .filter((keyword) =>
          isDue(keyword, stringCell(settings.get("timezone") as never) || "Europe/Belgrade"),
        )
        .sort((left, right) => numberCell(right.priority) - numberCell(left.priority));
      const keyword = keywords[0];
      if (!keyword) return;
      await this.#generateKeyword(keyword, settings);
    } finally {
      this.#running = false;
    }
  }

  async #generateKeyword(keyword: SheetRecord, settings: Map<string, unknown>): Promise<void> {
    const keywordId = stringCell(keyword.keyword_id);
    const startedAt = new Date().toISOString();
    await this.store.patchKeyword(keywordId, { status: "generating", updated_at: startedAt });
    try {
      const [guardrails, links] = await Promise.all([
        this.store.listGuardrails(),
        this.store.listLinks(),
      ]);
      const targetWords = numberCell(settings.get("default_article_length_words") as never) || 1_200;
      const generated = await this.generator!.generate({
        keyword,
        guardrails,
        allowedLinks: links.filter(
          (link) => stringCell(link.environment) === this.config.targetEnvironment,
        ),
        targetWords,
      });
      const articleId = createArticleId();
      const now = new Date().toISOString();
      const values: Record<string, string | number | boolean | null> = {
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
        title: generated.title,
        slug: generated.slug,
        excerpt: generated.excerpt,
        seo_title: generated.seo_title,
        meta_description: generated.meta_description,
        body_markdown: generated.body_markdown,
        tags: generated.tags.join(","),
        source_urls: generated.source_urls.join("\n"),
        internal_links: generated.internal_links.join("\n"),
        scheduled_publish_at: stringCell(keyword.planned_publish_at),
        quality_score: generated.quality_score,
        qa_status: generated.qa_blockers.length === 0 ? "passed" : "failed",
        qa_blockers: generated.qa_blockers.join(","),
        manual_required: false,
        revision_count: 0,
        created_at: now,
        updated_at: now,
      };
      values.content_hash = articleContentHash({ ...values, __rowNumber: 0 } as SheetRecord);
      await this.store.appendArticle(values);
      await this.store.patchKeyword(keywordId, {
        status: "used",
        used_at: now,
        article_id: articleId,
        updated_at: now,
      });
      await this.store.appendEvent({
        event_id: randomUUID(),
        article_id: articleId,
        event_type: "generated",
        from_status: "generating",
        to_status: "needs_review",
        actor_type: "system",
        actor_id: "generator",
        provider: "openai",
        message: `Generated from keyword ${keywordId}`,
        payload_json: JSON.stringify({ keyword_id: keywordId, model: this.config.openAiModel }),
        created_at: now,
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.logger.error({ keywordId, err: message }, "Article generation failed");
      await this.store.patchKeyword(keywordId, {
        status: "paused",
        research_notes: appendNote(stringCell(keyword.research_notes), `Generation failed: ${message}`),
        updated_at: new Date().toISOString(),
      });
    }
  }
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

function appendNote(existing: string, note: string): string {
  return [existing, `[${new Date().toISOString()}] ${note}`].filter(Boolean).join("\n").slice(-2_000);
}
