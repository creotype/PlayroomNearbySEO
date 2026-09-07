import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Article } from "../src/domain/article.js";
import {
  buildHeroImagePrompt,
  heroImagePromptHash,
  HERO_IMAGE_PROMPT_VERSION,
} from "../src/generation/hero-image-prompt.js";
import {
  OpenAiHeroImageGenerator,
  type HeroImageGenerator,
} from "../src/generation/openai-hero-image.js";
import type { GhostAdminClient } from "../src/ghost/client.js";
import { HeroImageService } from "../src/services/hero-image-service.js";

const temporaryDirectories: string[] = [];
const logger = { info: vi.fn() } as unknown as Logger;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function article(overrides: Partial<Article> = {}): Article {
  return {
    __rowNumber: 2,
    article_id: "SEO-1",
    locale: "sr",
    status: "needs_review",
    title: "Kako izabrati igraonicu za dete",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "## Vodič",
    topic: "izbor bezbedne igraonice",
    primary_keyword: "igraonice Beograd",
    excerpt: "Praktičan vodič za izbor prostora za igru.",
    ...overrides,
  } as Article;
}

function promptInput() {
  return {
    articleId: "SEO-1",
    locale: "sr",
    title: "Kako izabrati igraonicu za dete",
    topic: "izbor bezbedne igraonice",
    primaryKeyword: "igraonice Beograd",
    excerpt: "Praktičan vodič za izbor prostora za igru.",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "playroom-hero-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("hero image prompt", () => {
  it("is versioned, topic-specific, and keeps the brand safety constraints", () => {
    const prompt = buildHeroImagePrompt(promptInput());
    expect(prompt).toContain(`Prompt version: ${HERO_IMAGE_PROMPT_VERSION}`);
    expect(prompt).toContain("Subject: izbor bezbedne igraonice");
    expect(prompt).toContain("dominant orange and yellow palette");
    expect(prompt).toContain("Do not render any words, letters, numbers");
    expect(prompt).toContain("Do not show identifiable faces");
  });

  it("uses a stable content/settings fingerprint", () => {
    const settings = { model: "gpt-image-2", size: "1536x1024", quality: "high" };
    const first = heroImagePromptHash(promptInput(), settings);
    expect(heroImagePromptHash(promptInput(), settings)).toBe(first);
    expect(heroImagePromptHash({ ...promptInput(), topic: "rođendan" }, settings)).not.toBe(first);
  });
});

describe("OpenAiHeroImageGenerator", () => {
  it("requests one high-quality landscape WebP without calling a real API", async () => {
    const generate = vi.fn(async () => ({
      data: [{ b64_json: Buffer.from("generated-image").toString("base64") }],
    }));
    const client = { images: { generate } } as unknown as Pick<OpenAI, "images">;
    const generator = new OpenAiHeroImageGenerator(
      "test-key-never-sent",
      "gpt-image-2",
      "1536x1024",
      "high",
      client,
    );

    const result = await generator.generate(promptInput());

    expect(Buffer.from(result.bytes).toString()).toBe("generated-image");
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-image-2",
      n: 1,
      size: "1536x1024",
      quality: "high",
      output_format: "webp",
      output_compression: 90,
      background: "opaque",
    }));
  });
});

describe("HeroImageService", () => {
  it("persists the generated binary and Ghost URL across service restarts", async () => {
    const cacheDir = await temporaryDirectory();
    const generate = vi.fn(async () => ({
      bytes: Buffer.from("webp-bytes"),
      contentType: "image/webp" as const,
      extension: "webp" as const,
      alt: "Tematska ilustracija: izbor bezbedne igraonice",
    }));
    const generator = {
      cacheKey: () => "a".repeat(64),
      generate,
    } satisfies HeroImageGenerator;
    const uploadImage = vi.fn(async () => ({
      url: "https://example.com/content/images/playroom-hero.webp",
    }));
    const ghost = { uploadImage } as unknown as GhostAdminClient;

    const first = await new HeroImageService(generator, ghost, cacheDir, logger).ensureForArticle(article());
    const second = await new HeroImageService(
      { cacheKey: generator.cacheKey, generate: vi.fn(async () => { throw new Error("must not regenerate"); }) },
      { uploadImage: vi.fn(async () => { throw new Error("must not re-upload"); }) } as unknown as GhostAdminClient,
      cacheDir,
      logger,
    ).ensureForArticle(article());

    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledOnce();
    expect(uploadImage).toHaveBeenCalledOnce();
    expect(uploadImage).toHaveBeenCalledWith(expect.objectContaining({
      filename: expect.stringMatching(/^playroom-SEO-1-[a-f0-9]{16}-[a-f0-9]{12}\.webp$/u),
      ref: expect.stringMatching(new RegExp(`^playroom-hero-[a-f0-9]{16}-${"a".repeat(64)}$`, "u")),
    }));
  });

  it("retries only the Ghost upload when a prior upload attempt failed", async () => {
    const cacheDir = await temporaryDirectory();
    const generate = vi.fn(async () => ({
      bytes: Buffer.from("cached-webp"),
      contentType: "image/webp" as const,
      extension: "webp" as const,
      alt: "Tematska ilustracija: igraonica",
    }));
    const generator = { cacheKey: () => "b".repeat(64), generate } satisfies HeroImageGenerator;
    const failedGhost = {
      uploadImage: vi.fn(async () => { throw new Error("Ghost unavailable"); }),
    } as unknown as GhostAdminClient;
    await expect(
      new HeroImageService(generator, failedGhost, cacheDir, logger).ensureForArticle(article()),
    ).rejects.toThrow("Ghost unavailable");

    const uploadImage = vi.fn(async (input: { bytes: Uint8Array }) => {
      expect(Buffer.from(input.bytes).toString()).toBe("cached-webp");
      return { url: "https://example.com/content/images/retry.webp" };
    });
    const result = await new HeroImageService(
      { cacheKey: generator.cacheKey, generate: vi.fn(async () => { throw new Error("must use binary cache"); }) },
      { uploadImage } as unknown as GhostAdminClient,
      cacheDir,
      logger,
    ).ensureForArticle(article());

    expect(result.url).toBe("https://example.com/content/images/retry.webp");
    expect(generate).toHaveBeenCalledOnce();
    expect(uploadImage).toHaveBeenCalledOnce();
  });

  it("reuses the paid binary but never a Ghost URL from another environment", async () => {
    const cacheDir = await temporaryDirectory();
    const generate = vi.fn(async () => ({
      bytes: Buffer.from("shared-binary"),
      contentType: "image/webp" as const,
      extension: "webp" as const,
      alt: "Tematska ilustracija: igraonica",
    }));
    const generator = { cacheKey: () => "d".repeat(64), generate } satisfies HeroImageGenerator;
    const stagingUpload = vi.fn(async () => ({ url: "https://staging.example/content/hero.webp" }));
    const productionUpload = vi.fn(async (input: { bytes: Uint8Array }) => {
      expect(Buffer.from(input.bytes).toString()).toBe("shared-binary");
      return { url: "https://prod.example/content/hero.webp" };
    });

    await new HeroImageService(
      generator,
      { uploadImage: stagingUpload } as unknown as GhostAdminClient,
      cacheDir,
      logger,
      "staging:https://staging.example/internal",
    ).ensureForArticle(article());
    const production = await new HeroImageService(
      generator,
      { uploadImage: productionUpload } as unknown as GhostAdminClient,
      cacheDir,
      logger,
      "production:https://prod.example/internal",
    ).ensureForArticle(article());

    expect(production.url).toBe("https://prod.example/content/hero.webp");
    expect(generate).toHaveBeenCalledOnce();
    expect(stagingUpload).toHaveBeenCalledOnce();
    expect(productionUpload).toHaveBeenCalledOnce();
  });

  it("preserves a manually supplied URL and fills missing alt text without generation", async () => {
    const generator = {
      cacheKey: vi.fn(() => "c".repeat(64)),
      generate: vi.fn(),
    } as unknown as HeroImageGenerator;
    const ghost = { uploadImage: vi.fn() } as unknown as GhostAdminClient;
    const result = await new HeroImageService(
      generator,
      ghost,
      await temporaryDirectory(),
      logger,
    ).ensureForArticle(article({
      feature_image_url: "https://cdn.example.com/manual.webp",
      feature_image_alt: "",
    }));

    expect(result).toEqual({
      url: "https://cdn.example.com/manual.webp",
      alt: "Tematska ilustracija: izbor bezbedne igraonice",
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(ghost.uploadImage).not.toHaveBeenCalled();
  });
});
