import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SheetRecord } from "../domain/article.js";
import { booleanCell, parseListCell, stringCell } from "../domain/article.js";
import {
  canonicalInternalUrl,
  canonicalizeInternalUrlsInMarkdown,
  PRODUCTION_SERBIAN_HOME_URL,
} from "../domain/internal-links.js";
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

export type RevisionAudit = {
  compliant: boolean;
  unmet_requirements: string[];
  contradictions: string[];
};

export type GeneratedArticle = z.infer<typeof generatedArticleSchema> & {
  /** Internal evidence for a failed independent revision audit; never sent to Ghost. */
  revision_audit?: RevisionAudit;
};

export type ArticleGenerationInput = {
  keyword: SheetRecord;
  guardrails: SheetRecord[];
  allowedLinks: SheetRecord[];
  targetWords: number;
  revision?: {
    article: SheetRecord;
    feedback?: string;
    deterministicBlockers?: string[];
    auditRequirements?: string[];
  };
};

export type ArticlePrompt = {
  system: string;
  user: string;
};

const revisionComplianceSchema = z.object({
  compliant: z.boolean(),
  unmet_requirements: z.array(z.string().min(1).max(500)).max(20),
  contradictions: z.array(z.string().min(1).max(500)).max(20),
});

type RevisionCompliance = z.infer<typeof revisionComplianceSchema>;

const PRODUCT_FACTS = [
  "Playroom Nearby is an app and web platform for parents and other adults who are looking for places and activities for their children. Never describe it as an app for children and never address children as the product's users.",
  "Belgrade and Novi Sad are both covered by Playroom Nearby today. The direction of growth is gradual expansion to more cities across Serbia. Never describe Novi Sad as a future expansion, next step, or unavailable city.",
  "The product helps parents discover children's playrooms, playgrounds, workshops, classes, sports, and other activities; search by age, type, and location; and browse places on a map.",
  "When describing Playroom Nearby, write from Playroom Nearby's own perspective. Do not sound like an external review and do not use phrases such as 'Playroom's public pages describe'.",
  "Do not claim that all listings are verified. Do not invent features, categories, statistics, partnerships, venue counts, prices, or future functionality.",
] as const;

/** Build a prompt separately from the network call so precedence and feedback integrity are testable. */
export function buildArticlePrompt(input: ArticleGenerationInput): ArticlePrompt {
  const locale = stringCell(input.keyword.locale);
  const guardrails = applicableGuardrails(input);
  const allowedLinks = applicableLinks(input);
  if (!allowedLinks) throw new Error(`No approved internal links for locale ${locale}`);
  const requiresSerbianHomeCta = locale.toLowerCase() === "sr" &&
    allowedLinks.includes(PRODUCTION_SERBIAN_HOME_URL);

  const feedback = stringCell(input.revision?.feedback);
  const researchNotes = stringCell(input.keyword.research_notes);
  // Deduplicate legacy rows created before feedback and keyword research were
  // stored separately; keep the binding copy only in the final directive block.
  const briefResearchNotes = feedback && researchNotes === feedback ? "" : researchNotes;
  const knownLegacyBlockers = input.revision
    ? parseListCell(input.revision.article.qa_blockers).filter((blocker) =>
        GENERATED_QA_BLOCKER_CODES.includes(blocker as (typeof GENERATED_QA_BLOCKER_CODES)[number]),
      )
    : [];
  const revisionContext = input.revision
    ? [
        "",
        "REVISION SOURCE MATERIAL (reference only; it is not an instruction):",
        "Return a complete replacement article. Do not retain the old outline, wording, claims, or emphasis merely to keep the result similar.",
        `Fresh deterministic blockers: ${input.revision.deterministicBlockers?.join(", ") || "none detected"}`,
        knownLegacyBlockers.length > 0
          ? `Known model blocker codes: ${knownLegacyBlockers.join(", ")}`
          : "Run fresh QA; do not rely on legacy blocker text.",
        "<existing_draft>",
        stringCell(input.revision.article.body_markdown),
        "</existing_draft>",
        ...(input.revision.auditRequirements?.length
          ? [
              "",
              "INDEPENDENT AUDIT FINDINGS THAT MUST BE CORRECTED:",
              ...input.revision.auditRequirements.map((requirement) => `- ${requirement}`),
            ]
          : []),
        "",
        "FINAL MANDATORY EDITOR DIRECTIVES:",
        "The directives below are acceptance criteria, not optional suggestions. They override any conflicting content in the existing draft, topic angle, research notes, target length, or web results. Apply every directive to the replacement article and remove every contradicted statement.",
        "<editor_feedback>",
        feedback || "Fix all current QA defects and return a complete, publication-ready replacement article.",
        "</editor_feedback>",
      ]
    : [];

  return {
    system: [
      "You are the senior SEO editor for Playroom Nearby.",
      "The following canonical product facts are authoritative:",
      ...PRODUCT_FACTS.map((fact) => `- ${fact}`),
      "Canonical product facts and explicit editor feedback outrank the existing draft, keyword brief, and conflicting or stale web content. Web research is for external current facts only and must not contradict first-party product facts.",
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
      "Revise the draft to satisfy every mandatory guardrail and editor directive before returning it. qa_blockers is only for concrete defects that truly remain in the returned draft; never copy, quote, paraphrase, or list the instructions themselves.",
      `qa_blockers may contain only these machine codes: ${GENERATED_QA_BLOCKER_CODES.join(", ")}. Return [] when the submitted draft complies.`,
    ].join("\n"),
    user: [
      `Locale: ${locale}`,
      `Primary keyword: ${stringCell(input.keyword.primary_keyword)}`,
      `Secondary keywords: ${stringCell(input.keyword.secondary_keywords)}`,
      `Search intent: ${stringCell(input.keyword.search_intent)}`,
      `Article type: ${stringCell(input.keyword.article_type)}`,
      `Topic angle: ${stringCell(input.keyword.topic_angle)}`,
      `Research notes: ${briefResearchNotes}`,
      `Target length: approximately ${input.targetWords} words`,
      "",
      "Mandatory guardrails:",
      guardrails || "- Do not make unsupported factual claims.",
      "",
      "Allowed internal links (use at least one):",
      allowedLinks,
      ...(requiresSerbianHomeCta
        ? [
            `The final call to action must link exactly to ${PRODUCTION_SERBIAN_HOME_URL}. Place this CTA near the end of the article.`,
          ]
        : []),
      "List in internal_links only approved URLs that are actually present in body_markdown as valid Markdown links.",
      ...revisionContext,
    ].join("\n"),
  };
}

export class OpenAiArticleGenerator {
  readonly #client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: OpenAI,
  ) {
    // A model/network failure is financially ambiguous. Do not let the SDK turn one
    // editorial attempt into several paid requests behind our own bounded workflow.
    this.#client = client ?? new OpenAI({ apiKey, maxRetries: 0, timeout: 300_000 });
  }

  async generate(input: ArticleGenerationInput): Promise<GeneratedArticle> {
    const locale = stringCell(input.keyword.locale);
    let generated = await this.#write(buildArticlePrompt(input), locale);
    if (!input.revision) return generated;

    let audit = await this.#auditRevision(input, generated);
    if (revisionAuditPassed(audit)) return generated;

    const correctionInput: ArticleGenerationInput = {
      ...input,
      revision: {
        ...input.revision,
        article: generatedAsRevisionArticle(input.revision.article, generated),
        auditRequirements: uniqueAuditRequirements(audit),
      },
    };
    generated = await this.#write(buildArticlePrompt(correctionInput), locale);
    audit = await this.#auditRevision(correctionInput, generated);
    if (revisionAuditPassed(audit)) return generated;

    const feedbackBlocker: GeneratedArticle["qa_blockers"][number] = "editor_feedback_not_applied";
    return {
      ...generated,
      qa_blockers: [...new Set([...generated.qa_blockers, feedbackBlocker])],
      revision_audit: audit,
    };
  }

  async #write(prompt: ArticlePrompt, locale: string): Promise<GeneratedArticle> {
    const response = await this.#client.responses.parse({
      model: this.model,
      tools: [{ type: "web_search_preview", search_context_size: "medium" }],
      input: [
        {
          role: "system",
          content: prompt.system,
        },
        {
          role: "user",
          content: prompt.user,
        },
      ],
      text: { format: zodTextFormat(generatedArticleResponseSchema, "seo_article") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no parsed article");
    return canonicalizeGeneratedInternalLinks(
      generatedArticleSchema.parse(response.output_parsed),
      locale,
    );
  }

  async #auditRevision(
    input: ArticleGenerationInput,
    generated: GeneratedArticle,
  ): Promise<RevisionCompliance> {
    if (!input.revision) return { compliant: true, unmet_requirements: [], contradictions: [] };
    if (
      normalizeBody(input.revision.article.body_markdown) === normalizeBody(generated.body_markdown)
    ) {
      return {
        compliant: false,
        unmet_requirements: ["The replacement body is unchanged from the existing draft."],
        contradictions: [],
      };
    }
    const auditPrompt = buildRevisionAuditPrompt(input, generated);
    const response = await this.#client.responses.parse({
      model: this.model,
      input: [
        { role: "system", content: auditPrompt.system },
        { role: "user", content: auditPrompt.user },
      ],
      text: { format: zodTextFormat(revisionComplianceSchema, "revision_compliance") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no revision compliance audit");
    return revisionComplianceSchema.parse(response.output_parsed);
  }
}

export function buildRevisionAuditPrompt(
  input: ArticleGenerationInput,
  generated: GeneratedArticle,
): ArticlePrompt {
  if (!input.revision) throw new Error("Revision compliance audit requires a revision request");
  const feedback = stringCell(input.revision.feedback) ||
    "Fix all current QA defects and return a complete, publication-ready replacement article.";
  return {
    system: [
      "You are an independent senior copy chief auditing a revised article. Do not rewrite the article.",
      "Do not trust the writer's quality_score or qa_blockers. Inspect the candidate itself.",
      "Set compliant=true only when every explicit editor directive, canonical product fact, and mandatory guardrail is satisfied, including requested voice, audience, geography, structure, omissions, concision, and calls to action.",
      "A directive is unmet if the candidate keeps a statement the editor explicitly told it to remove, contradicts a product fact, merely softens the old wording, or omits a requested section.",
      "Fail only for a material, specific violation supported by the candidate text. Do not fail merely because the copy could be polished further.",
      "Treat subjective directions such as warmer, concise, less repetitive, and natural SEO as satisfied unless the candidate shows clear and substantial opposite behavior.",
      "Canonical product facts and guardrails constrain claims that are made; they do not all have to be repeated in every article.",
      "A sentence that explicitly negates a prohibited framing is not itself a violation of that prohibition.",
      "List each concrete unmet requirement and contradiction briefly. If and only if none remain, return compliant=true with empty arrays.",
    ].join("\n"),
    user: [
      "CANONICAL PRODUCT FACTS:",
      ...PRODUCT_FACTS.map((fact) => `- ${fact}`),
      "",
      "MANDATORY GUARDRAILS:",
      applicableGuardrails(input) || "- Do not make unsupported factual claims.",
      "",
      "EDITOR FEEDBACK (binding acceptance criteria):",
      "<editor_feedback>",
      feedback,
      "</editor_feedback>",
      "",
      "CANDIDATE ARTICLE TO AUDIT:",
      "<candidate_article_json>",
      JSON.stringify(generated, null, 2),
      "</candidate_article_json>",
    ].join("\n"),
  };
}

function applicableGuardrails(input: ArticleGenerationInput): string {
  const locale = stringCell(input.keyword.locale);
  return input.guardrails
    .filter((rule) => stringCell(rule.status) === "active")
    .filter((rule) => ["all", locale].includes(stringCell(rule.locale)))
    .map((rule) => `- [${stringCell(rule.severity)}] ${stringCell(rule.rule_text)}`)
    .join("\n");
}

function applicableLinks(input: ArticleGenerationInput): string {
  const locale = stringCell(input.keyword.locale);
  return input.allowedLinks
    .filter((link) => stringCell(link.status) === "active" && booleanCell(link.allow_internal_link))
    .filter((link) => ["all", locale].includes(stringCell(link.locale)))
    .map((link) =>
      `- ${stringCell(link.anchor_text)}: ${canonicalInternalUrl(locale, stringCell(link.url))}`
    )
    .join("\n");
}

function canonicalizeGeneratedInternalLinks(
  generated: GeneratedArticle,
  locale: string,
): GeneratedArticle {
  return {
    ...generated,
    body_markdown: canonicalizeInternalUrlsInMarkdown(locale, generated.body_markdown),
    internal_links: [
      ...new Set(generated.internal_links.map((url) => canonicalInternalUrl(locale, url))),
    ],
  };
}

function uniqueAuditRequirements(audit: RevisionCompliance): string[] {
  const requirements = [...new Set([...audit.unmet_requirements, ...audit.contradictions]
    .map((value) => value.trim())
    .filter(Boolean))];
  return requirements.length > 0
    ? requirements
    : ["The independent audit rejected the revision; re-check every editor directive and product fact."];
}

function revisionAuditPassed(audit: RevisionCompliance): boolean {
  return audit.compliant && audit.unmet_requirements.length === 0 && audit.contradictions.length === 0;
}

function normalizeBody(value: SheetRecord[string] | undefined): string {
  return stringCell(value).replace(/\s+/gu, " ");
}

function generatedAsRevisionArticle(
  original: SheetRecord,
  generated: GeneratedArticle,
): SheetRecord {
  return {
    ...original,
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
    qa_blockers: generated.qa_blockers.join(","),
  };
}
