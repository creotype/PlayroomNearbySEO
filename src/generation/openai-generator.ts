import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SheetRecord } from "../domain/article.js";
import { booleanCell, stringCell } from "../domain/article.js";

export const generatedArticleResponseSchema = z.object({
  title: z.string().min(10).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().min(40).max(300),
  seo_title: z.string().min(20).max(60),
  meta_description: z.string().min(80).max(160),
  body_markdown: z.string().min(2_500),
  tags: z.array(z.string().min(1)).max(8),
  // OpenAI strict structured outputs reject JSON Schema `format: uri`.
  // Keep the wire schema format-free and apply URL validation after parsing.
  source_urls: z.array(z.string().min(8).max(2_048)).min(1),
  internal_links: z.array(z.string().min(8).max(2_048)).min(1),
  quality_score: z.number().min(0).max(10),
  qa_blockers: z.array(z.string()),
});

const generatedArticleSchema = generatedArticleResponseSchema.extend({
  source_urls: z.array(z.string().url()).min(1),
  internal_links: z.array(z.string().url()).min(1),
});

export type GeneratedArticle = z.infer<typeof generatedArticleSchema>;

export class OpenAiArticleGenerator {
  readonly #client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.#client = new OpenAI({ apiKey });
  }

  async generate(input: {
    keyword: SheetRecord;
    guardrails: SheetRecord[];
    allowedLinks: SheetRecord[];
    targetWords: number;
  }): Promise<GeneratedArticle> {
    const locale = stringCell(input.keyword.locale);
    const guardrails = input.guardrails
      .filter((rule) => stringCell(rule.status) === "active")
      .filter((rule) => ["all", locale].includes(stringCell(rule.locale)))
      .map((rule) => `- [${stringCell(rule.severity)}] ${stringCell(rule.rule_text)}`)
      .join("\n");
    const allowedLinks = input.allowedLinks
      .filter((link) => stringCell(link.status) === "active" && booleanCell(link.allow_internal_link))
      .filter((link) => ["all", locale].includes(stringCell(link.locale)))
      .map((link) => `- ${stringCell(link.anchor_text)}: ${stringCell(link.url)}`)
      .join("\n");
    if (!allowedLinks) throw new Error(`No approved internal links for locale ${locale}`);

    const response = await this.#client.responses.parse({
      model: this.model,
      tools: [{ type: "web_search_preview", search_context_size: "medium" }],
      input: [
        {
          role: "system",
          content: [
            "You are the senior SEO editor for Playroom, a guide to children's playrooms in Belgrade.",
            "Return a useful, natural article in the requested language. Never invent venue facts, prices, addresses, opening hours, age limits, capacity, services, certifications, ratings, or guarantees.",
            "Use web research for current factual claims. Include every authoritative source URL you relied on in source_urls.",
            "Only use internal links from the explicit allow-list. Do not place source citations as raw footnotes inside the article; write clean editorial prose.",
            "Serbian content uses Latin script unless the brief explicitly requests Cyrillic.",
            "Body must be Markdown with one H1-equivalent title omitted from the body, descriptive H2/H3 sections, practical guidance, and a concise conclusion.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Locale: ${locale}`,
            `Primary keyword: ${stringCell(input.keyword.primary_keyword)}`,
            `Secondary keywords: ${stringCell(input.keyword.secondary_keywords)}`,
            `Search intent: ${stringCell(input.keyword.search_intent)}`,
            `Article type: ${stringCell(input.keyword.article_type)}`,
            `Topic angle: ${stringCell(input.keyword.topic_angle)}`,
            `Research notes: ${stringCell(input.keyword.research_notes)}`,
            `Target length: approximately ${input.targetWords} words`,
            "",
            "Mandatory guardrails:",
            guardrails || "- Do not make unsupported factual claims.",
            "",
            "Allowed internal links (use at least one):",
            allowedLinks,
          ].join("\n"),
        },
      ],
      text: { format: zodTextFormat(generatedArticleResponseSchema, "seo_article") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no parsed article");
    return generatedArticleSchema.parse(response.output_parsed);
  }
}
