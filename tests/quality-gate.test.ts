import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Article, CellValue, SheetRecord } from "../src/domain/article.js";
import {
  LEGACY_SERBIAN_HOME_URL,
  PRODUCTION_SERBIAN_HOME_URL,
} from "../src/domain/internal-links.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { QualityGate } from "../src/services/quality-gate.js";

const internalUrl = "https://beaver.run.place/rs";

const config = {
  targetEnvironment: "staging",
} as AppConfig;

function validBody(): string {
  return `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n[Playroom vodič](${internalUrl})`;
}

function article(overrides: Partial<Article> = {}): Article {
  return {
    __rowNumber: 2,
    article_id: "SEO-TEST-1",
    keyword_id: "KW-TEST-1",
    locale: "sr",
    status: "needs_review",
    title: "Kako izabrati igraonicu u Beogradu",
    slug: "kako-izabrati-igraonicu-u-beogradu",
    body_markdown: validBody(),
    seo_title: "Kako izabrati igraonicu u Beogradu",
    meta_description:
      "Praktični saveti za izbor igraonice u Beogradu, uz jasna pitanja o programu, prostoru i organizaciji proslave.",
    source_urls: "https://example.com/source",
    internal_links: internalUrl,
    feature_image_url: "https://example.com/content/images/hero.webp",
    feature_image_alt: "Tematska ilustracija: izbor igraonice",
    quality_score: 9,
    qa_status: "pass",
    qa_blockers: "",
    manual_required: false,
    ...overrides,
  };
}

function gate(settings: Record<string, CellValue> = {}): QualityGate {
  const store = {
    getSettings: async () =>
      new Map<string, CellValue>([
        ["qa_min_score", 8],
        ["enabled_locales", "sr,en"],
        ["ru_enabled", false],
        ...Object.entries(settings),
      ]),
    listLinks: async () =>
      [
        {
          __rowNumber: 2,
          environment: "staging",
          locale: "sr",
          url: internalUrl,
          status: "active",
          allow_internal_link: true,
        },
      ] as SheetRecord[],
  };
  return new QualityGate(store as unknown as GoogleSheetsStore, config);
}

function productionGate(allowedUrl = LEGACY_SERBIAN_HOME_URL): QualityGate {
  const store = {
    getSettings: async () =>
      new Map<string, CellValue>([
        ["qa_min_score", 8],
        ["enabled_locales", "sr,en"],
        ["ru_enabled", false],
      ]),
    listLinks: async () =>
      [
        {
          __rowNumber: 10,
          environment: "production",
          locale: "sr",
          url: allowedUrl,
          status: "active",
          allow_internal_link: true,
        },
      ] as SheetRecord[],
  };
  return new QualityGate(
    store as unknown as GoogleSheetsStore,
    { targetEnvironment: "production" } as AppConfig,
  );
}

describe("QualityGate content integrity", () => {
  it("passes a clean article using Sheet-native pass status", async () => {
    await expect(gate().evaluate(article())).resolves.toEqual({
      passed: true,
      blockers: [],
      score: 9,
    });
  });

  it("requires a declared internal URL to occur in a valid Markdown link", async () => {
    const body = `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n[Playroom vodič].(${internalUrl})`;
    const result = await gate().evaluate(article({ body_markdown: body }));
    expect(result.blockers).toEqual(
      expect.arrayContaining(["internal_link_not_in_body", "malformed_markdown_link"]),
    );
  });

  it("blocks external URLs in the body and tracking parameters in source URLs", async () => {
    const result = await gate().evaluate(
      article({
        body_markdown: `${validBody()}\n\n[Izvor](https://example.com/story?utm_source=openai)`,
        source_urls: "https://example.com/story?utm_source=openai",
      }),
    );
    expect(result.blockers).toEqual(
      expect.arrayContaining(["external_url_in_body", "tracking_parameters_in_source_url"]),
    );
  });

  it("recomputes QA from current content instead of stale model fields", async () => {
    const rawGuardrail = "Avoid absolute claims like najbolji without sources or guarantees";
    const result = await gate().evaluate(
      article({ qa_status: "fail", qa_blockers: rawGuardrail }),
    );
    expect(result).toEqual({ passed: true, blockers: [], score: 9 });
  });

  it("blocks a visibly truncated meta description", async () => {
    const result = await gate().evaluate(
      article({
        meta_description:
          "Praktični saveti za izbor igraonice u Beogradu, uz jasna pitanja o programu i stvari koje treba prover",
      }),
    );
    expect(result.blockers).toContain("meta_description_incomplete");
  });

  it("blocks approval when the hero image or its alt text is missing", async () => {
    const result = await gate().evaluate(article({
      feature_image_url: "",
      feature_image_alt: "",
    }));
    expect(result.blockers).toEqual(
      expect.arrayContaining(["missing_feature_image", "missing_feature_image_alt"]),
    );
  });

  it("accepts only the canonical Serbian home CTA even when Sheet still contains the legacy URL", async () => {
    const body = `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n` +
      `[Istražite Playroom](${PRODUCTION_SERBIAN_HOME_URL})`;
    await expect(productionGate().evaluate(article({
      body_markdown: body,
      internal_links: PRODUCTION_SERBIAN_HOME_URL,
    }))).resolves.toEqual({ passed: true, blockers: [], score: 9 });
  });

  it("rejects the obsolete Serbian home URL even when it is active in Sheet", async () => {
    const body = `${Array.from({ length: 510 }, () => "savet").join(" ")}\n\n` +
      `[Istražite Playroom](${LEGACY_SERBIAN_HOME_URL})`;
    const result = await productionGate().evaluate(article({
      body_markdown: body,
      internal_links: LEGACY_SERBIAN_HOME_URL,
    }));
    expect(result.blockers).toEqual(expect.arrayContaining([
      "external_url_in_body",
      "invalid_internal_link",
      "internal_link_not_in_body",
    ]));
  });

  it("requires the canonical Serbian CTA near the end of the article", async () => {
    const body = `[Istražite Playroom](${PRODUCTION_SERBIAN_HOME_URL})\n\n` +
      Array.from({ length: 510 }, () => "savet").join(" ");
    const result = await productionGate(PRODUCTION_SERBIAN_HOME_URL).evaluate(article({
      body_markdown: body,
      internal_links: PRODUCTION_SERBIAN_HOME_URL,
    }));
    expect(result.blockers).toContain("internal_link_not_in_body");
  });
});
