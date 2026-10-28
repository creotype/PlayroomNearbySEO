import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  generatedArticleResponseSchema,
  generatedQaBlockerSchema,
} from "../src/generation/openai-generator.js";

describe("OpenAI article response schema", () => {
  it("does not emit the unsupported uri format", () => {
    const format = zodTextFormat(generatedArticleResponseSchema, "seo_article");
    expect(JSON.stringify(format)).not.toContain('"format":"uri"');
  });

  it("accepts only bounded machine codes for model-reported blockers", () => {
    expect(generatedQaBlockerSchema.parse("missing_authoritative_source")).toBe(
      "missing_authoritative_source",
    );
    expect(generatedQaBlockerSchema.parse("editor_feedback_not_applied")).toBe(
      "editor_feedback_not_applied",
    );
    expect(() =>
      generatedQaBlockerSchema.parse(
        "Any fact about a specific playroom must have authoritative source_url",
      ),
    ).toThrow();
  });
});
