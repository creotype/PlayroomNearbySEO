import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SheetRecord } from "../domain/article.js";
import { booleanCell, parseListCell, stringCell } from "../domain/article.js";
import { GENERATED_QA_BLOCKER_CODES } from "../domain/quality.js";

export const generatedQaBlockerSchema = z.enum(GENERATED_QA_BLOCKER_CODES);

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
  quality_score: z.number().min(0).max(10).describe(
    "Editorial quality score on a 0 to 10 scale. Never use a 0 to 1 probability scale.",
  ),
  qa_blockers: z.array(generatedQaBlockerSchema).max(GENERATED_QA_BLOCKER_CODES.length),
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
    // A model/network failure is financially ambiguous. Do not let the SDK turn one
    // editorial attempt into several paid requests behind our own bounded workflow.
    this.#client = new OpenAI({ apiKey, maxRetries: 0, timeout: 300_000 });
  }

  async generate(input: {
    keyword: SheetRecord;
    guardrails: SheetRecord[];
    allowedLinks: SheetRecord[];
    targetWords: number;
    revision?: {
      article: SheetRecord;
      feedback?: string;
      deterministicBlockers?: string[];
    };
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

    const knownLegacyBlockers = input.revision
      ? parseListCell(input.revision.article.qa_blockers).filter((blocker) =>
          GENERATED_QA_BLOCKER_CODES.includes(blocker as (typeof GENERATED_QA_BLOCKER_CODES)[number]),
        )
      : [];
    const revisionContext = input.revision
      ? [
          "",
          "Revision request:",
          "Rewrite and correct the existing draft below. Preserve useful material, but return a complete replacement article that satisfies every rule.",
          `Editor feedback: ${stringCell(input.revision.feedback) || "Fix all current QA defects."}`,
          `Fresh deterministic blockers: ${input.revision.deterministicBlockers?.join(", ") || "none detected"}`,
          knownLegacyBlockers.length > 0
            ? `Known model blocker codes: ${knownLegacyBlockers.join(", ")}`
            : "Run fresh QA; do not rely on legacy blocker text.",
          "",
          "Existing draft:",
          stringCell(input.revision.article.body_markdown),
        ]
      : [];

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
            "For claims about a named venue, use that venue's official site or another primary authoritative source; never use a directory or aggregator as authority. If no authoritative source exists, omit the claim.",
            "Return canonical source_urls without fragments or tracking parameters such as utm_source, utm_medium, gclid, or fbclid.",
            "Only use internal links from the explicit allow-list. Every URL in internal_links must occur in body_markdown as a valid Markdown link: [descriptive anchor](exact approved URL).",
            "Do not put external URLs, source citations, raw footnotes, or citation markers in body_markdown; source_urls is the only place for research sources.",
            "Serbian content uses Latin script unless the brief explicitly requests Cyrillic.",
            "Body must be Markdown with one H1-equivalent title omitted from the body, descriptive H2/H3 sections, practical guidance, and a concise conclusion.",
            "The meta description must be a complete natural sentence. Never truncate a word or sentence to meet the character limit; aim for 120-150 characters.",
            "quality_score is an editorial score from 0 to 10, where 10 is excellent. Never return a probability or a 0-to-1 value. A clean publication-ready draft should normally score 8.0-10.0; a score below 8.0 means the draft still needs correction.",
            "Revise the draft to satisfy every mandatory guardrail before returning it. qa_blockers is only for concrete defects that truly remain in the returned draft; never copy, quote, paraphrase, or list the guardrail instructions themselves.",
            `qa_blockers may contain only these machine codes: ${GENERATED_QA_BLOCKER_CODES.join(", ")}. Return [] when the submitted draft complies.`,
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
            "List in internal_links only approved URLs that are actually present in body_markdown as valid Markdown links.",
            ...revisionContext,
          ].join("\n"),
        },
      ],
      text: { format: zodTextFormat(generatedArticleResponseSchema, "seo_article") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no parsed article");
    return generatedArticleSchema.parse(response.output_parsed);
  }
}
