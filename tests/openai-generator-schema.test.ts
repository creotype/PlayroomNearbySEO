import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import { generatedArticleResponseSchema } from "../src/generation/openai-generator.js";

describe("OpenAI article response schema", () => {
  it("does not emit the unsupported uri format", () => {
    const format = zodTextFormat(generatedArticleResponseSchema, "seo_article");
    expect(JSON.stringify(format)).not.toContain('"format":"uri"');
  });
});
