import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { SheetRecord } from "../src/domain/article.js";
import {
  LEGACY_SERBIAN_HOME_URL,
  PRODUCTION_SERBIAN_HOME_URL,
} from "../src/domain/internal-links.js";
import {
  buildArticlePrompt,
  buildRevisionAuditPrompt,
  type ArticleGenerationInput,
  type GeneratedArticle,
  OpenAiArticleGenerator,
} from "../src/generation/openai-generator.js";

const feedback = [
  "Please rewrite the article with the following corrections:",
  "Playroom Nearby is for parents and other adults, never children as users.",
  "Belgrade AND Novi Sad are already available; neither city is a future next step.",
  "Write from our own perspective and remove external-review phrasing.",
  "Use this exact structure: What is Playroom Nearby? → Why we built it → What parents can find → Explore Playroom Nearby.",
  ...Array.from({ length: 24 }, (_, index) =>
    `Requirement ${index + 1}: keep the article warm, concise, factual, and free of generic SEO filler.`,
  ),
].join("\n");

function record(values: Record<string, unknown>): SheetRecord {
  return { __rowNumber: 2, ...values } as SheetRecord;
}

function revisionInput(): ArticleGenerationInput {
  return {
    keyword: record({
      locale: "en",
      primary_keyword: "Playroom Nearby kids activities Serbia",
      secondary_keywords: "kids activities Belgrade, kids activities Novi Sad",
      search_intent: "informational",
      article_type: "guide",
      topic_angle: "Old topic that incorrectly focuses only on Belgrade",
      // This mirrors the current GenerationService call and must not duplicate feedback.
      research_notes: feedback,
    }),
    guardrails: [record({
      rule_id: "GR-1",
      locale: "all",
      severity: "blocker",
      rule_text: "Do not invent product facts.",
      status: "active",
    })],
    allowedLinks: [record({
      locale: "en",
      anchor_text: "Explore Playroom Nearby",
      url: "https://playroom-kids.app/en",
      status: "active",
      allow_internal_link: true,
    })],
    targetWords: 1_200,
    revision: {
      article: record({
        body_markdown: "## Belgrade now\nNovi Sad may be our next step. Playroom's public pages describe the product.",
        qa_blockers: "",
      }),
      feedback,
      deterministicBlockers: [],
    },
  };
}

function generated(marker: string): GeneratedArticle {
  return {
    title: `Playroom Nearby guide for parents ${marker}`,
    slug: `playroom-nearby-guide-${marker}`,
    excerpt: `A practical introduction to Playroom Nearby for parents in Belgrade and Novi Sad ${marker}.`,
    seo_title: `Playroom Nearby parent guide ${marker}`,
    meta_description: `Discover how Playroom Nearby helps parents find children's activities across Belgrade and Novi Sad today. ${marker}.`,
    body_markdown: `## ${marker}\n\n${"Useful parent-focused article text. ".repeat(100)}`,
    tags: ["parents", "serbia"],
    source_urls: ["https://playroom-kids.app/en/about"],
    internal_links: ["https://playroom-kids.app/en"],
    quality_score: 9,
    qa_blockers: [],
  };
}

function mockClient(outputs: unknown[]) {
  const parse = vi.fn();
  for (const output of outputs) parse.mockResolvedValueOnce({ output_parsed: output });
  return {
    client: { responses: { parse } } as unknown as OpenAI,
    parse,
  };
}

describe("article revision prompt", () => {
  it("binds canonical product facts and places full editor feedback after the old draft", () => {
    const prompt = buildArticlePrompt(revisionInput());

    expect(prompt.system).toContain("app and web platform for parents and other adults");
    expect(prompt.system).toContain("Belgrade and Novi Sad are both covered");
    expect(prompt.system).toContain("gradual expansion to more cities across Serbia");
    expect(prompt.system).toContain("write from Playroom Nearby's own perspective");
    expect(prompt.system).toContain("Do not claim that all listings are verified");
    expect(prompt.system).not.toContain("guide to children's playrooms in Belgrade");
    expect(prompt.user).not.toContain("Preserve useful material");
    expect(prompt.user.indexOf("<existing_draft>")).toBeLessThan(
      prompt.user.indexOf("FINAL MANDATORY EDITOR DIRECTIVES"),
    );
    expect(prompt.user.indexOf("</existing_draft>")).toBeLessThan(
      prompt.user.indexOf(feedback),
    );
    expect(prompt.user).toContain(
      "override any conflicting content in the existing draft, topic angle, research notes, target length, or web results",
    );
    expect(prompt.user.split(feedback)).toHaveLength(2);
    expect(prompt.user).toContain(`<editor_feedback>\n${feedback}\n</editor_feedback>`);
    expect(prompt.user.trimEnd().endsWith("</editor_feedback>")).toBe(true);
  });

  it("includes the complete long feedback in the independent audit", () => {
    const prompt = buildRevisionAuditPrompt(revisionInput(), generated("first"));
    expect(feedback.length).toBeGreaterThan(2_000);
    expect(prompt.user).toContain(`<editor_feedback>\n${feedback}\n</editor_feedback>`);
    expect(prompt.user).toContain("Belgrade and Novi Sad are both covered");
    expect(prompt.system).toContain("Do not trust the writer's quality_score");
    expect(prompt.system).toContain("Fail only for a material, specific violation");
    expect(prompt.system).toContain("do not all have to be repeated");
  });

  it("normalizes the Serbian allow-list and requires the canonical final CTA", () => {
    const input = revisionInput();
    input.keyword.locale = "sr";
    input.allowedLinks[0]!.locale = "sr";
    input.allowedLinks[0]!.url = LEGACY_SERBIAN_HOME_URL;
    const prompt = buildArticlePrompt(input);

    expect(prompt.user).toContain(PRODUCTION_SERBIAN_HOME_URL);
    expect(prompt.user).toContain("final call to action");
    expect(prompt.user).not.toContain(LEGACY_SERBIAN_HOME_URL);
  });
});

describe("bounded revision compliance audit", () => {
  it("rejects an unchanged body deterministically before spending an audit call", async () => {
    const first = generated("unchanged");
    const corrected = generated("corrected-after-unchanged");
    const input = revisionInput();
    input.revision!.article.body_markdown = first.body_markdown;
    const { client, parse } = mockClient([
      first,
      corrected,
      { compliant: true, unmet_requirements: [], contradictions: [] },
    ]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    await expect(generator.generate(input)).resolves.toEqual(corrected);
    expect(parse).toHaveBeenCalledTimes(3);
    const correctionUserPrompt = String(parse.mock.calls[1]?.[0]?.input?.[1]?.content ?? "");
    expect(correctionUserPrompt).toContain("The replacement body is unchanged from the existing draft.");
  });

  it("runs one corrective rewrite with audit findings and accepts the passing result", async () => {
    const first = generated("first");
    const corrected = generated("corrected");
    const { client, parse } = mockClient([
      first,
      {
        compliant: false,
        unmet_requirements: ["Novi Sad is still presented as a future expansion."],
        contradictions: ["The article uses an external-review voice."],
      },
      corrected,
      { compliant: true, unmet_requirements: [], contradictions: [] },
    ]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    await expect(generator.generate(revisionInput())).resolves.toEqual(corrected);
    expect(parse).toHaveBeenCalledTimes(4);
    expect(parse.mock.calls[0]?.[0]).toHaveProperty("tools");
    expect(parse.mock.calls[1]?.[0]).not.toHaveProperty("tools");
    expect(parse.mock.calls[2]?.[0]).toHaveProperty("tools");
    expect(parse.mock.calls[3]?.[0]).not.toHaveProperty("tools");
    const correctionUserPrompt = String(parse.mock.calls[2]?.[0]?.input?.[1]?.content ?? "");
    expect(correctionUserPrompt).toContain("INDEPENDENT AUDIT FINDINGS THAT MUST BE CORRECTED");
    expect(correctionUserPrompt).toContain("Novi Sad is still presented as a future expansion.");
    expect(correctionUserPrompt).toContain("The article uses an external-review voice.");
    expect(correctionUserPrompt).toContain(`<editor_feedback>\n${feedback}\n</editor_feedback>`);
    expect(correctionUserPrompt).toContain(first.body_markdown.trim());
  });

  it("does not accept an internally inconsistent passing audit", async () => {
    const corrected = generated("audit-fix");
    const { client, parse } = mockClient([
      generated("first-inconsistent"),
      {
        compliant: true,
        unmet_requirements: ["The requested parent CTA is still missing."],
        contradictions: [],
      },
      corrected,
      { compliant: true, unmet_requirements: [], contradictions: [] },
    ]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    await expect(generator.generate(revisionInput())).resolves.toEqual(corrected);
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("stops after one correction and returns a blocker when the second audit still fails", async () => {
    const { client, parse } = mockClient([
      generated("first"),
      { compliant: false, unmet_requirements: ["Wrong audience."], contradictions: [] },
      generated("second"),
      { compliant: false, unmet_requirements: ["Wrong audience remains."], contradictions: [] },
    ]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    const result = await generator.generate(revisionInput());
    expect(parse).toHaveBeenCalledTimes(4);
    expect(result.qa_blockers).toContain("editor_feedback_not_applied");
    expect(result.revision_audit).toEqual({
      compliant: false,
      unmet_requirements: ["Wrong audience remains."],
      contradictions: [],
    });
  });

  it("does not spend audit calls for an initial article generation", async () => {
    const input = revisionInput();
    delete input.revision;
    const first = generated("initial");
    const { client, parse } = mockClient([first]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    await expect(generator.generate(input)).resolves.toEqual(first);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("canonicalizes a legacy Serbian CTA returned by the model", async () => {
    const input = revisionInput();
    delete input.revision;
    input.keyword.locale = "sr";
    input.allowedLinks[0]!.locale = "sr";
    input.allowedLinks[0]!.url = LEGACY_SERBIAN_HOME_URL;
    const first = {
      ...generated("legacy-serbian-link"),
      body_markdown: `${generated("legacy-serbian-link").body_markdown}\n\n` +
        `[Istražite Playroom](${LEGACY_SERBIAN_HOME_URL})`,
      internal_links: [LEGACY_SERBIAN_HOME_URL],
    };
    const { client, parse } = mockClient([first]);
    const generator = new OpenAiArticleGenerator("sk-test-value", "gpt-test", client);

    const result = await generator.generate(input);
    expect(parse).toHaveBeenCalledOnce();
    expect(result.internal_links).toEqual([PRODUCTION_SERBIAN_HOME_URL]);
    expect(result.body_markdown).toContain(`](${PRODUCTION_SERBIAN_HOME_URL})`);
    expect(result.body_markdown).not.toContain(LEGACY_SERBIAN_HOME_URL);
  });
});
