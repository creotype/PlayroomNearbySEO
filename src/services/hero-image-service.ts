import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { stringCell, type Article } from "../domain/article.js";
import {
  MAX_HERO_IMAGE_BYTES,
  type HeroImageGenerator,
} from "../generation/openai-hero-image.js";
import { heroImageAlt, type HeroImagePromptInput } from "../generation/hero-image-prompt.js";
import type { GhostAdminClient } from "../ghost/client.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";

export type PreparedHeroImage = { url: string; alt: string };

type CachedUpload = {
  version: 1;
  cacheKey: string;
  ghostUrl: string;
  alt: string;
  uploadScope: string;
};

/**
 * Generates once, caches the binary on durable storage, uploads it, then caches
 * the returned Ghost URL. Once the binary commit succeeds, a process restart does
 * not repeat a paid generation. The deterministic Ghost `ref` and filename also
 * make remote duplicates traceable if the process dies in the narrow interval
 * after upload but before metadata commit.
 */
export class HeroImageService {
  readonly #mutex = new KeyedMutex();
  readonly #uploadScope: string;

  constructor(
    private readonly generator: HeroImageGenerator,
    private readonly ghost: GhostAdminClient,
    private readonly cacheDir: string,
    private readonly logger: Logger,
    uploadScope = "default",
  ) {
    this.#uploadScope = createHash("sha256").update(uploadScope).digest("hex").slice(0, 16);
  }

  async ensureForArticle(article: Article): Promise<PreparedHeroImage> {
    const input = promptInput(article);
    const existingUrl = stringCell(article.feature_image_url);
    const existingAlt = stringCell(article.feature_image_alt);
    if (existingUrl) {
      assertHttpUrl(existingUrl);
      return { url: existingUrl, alt: existingAlt || heroImageAlt(input) };
    }

    const cacheKey = this.generator.cacheKey(input);
    return this.#mutex.runExclusive(`${this.#uploadScope}:${cacheKey}`, async () => {
      await mkdir(this.cacheDir, { recursive: true });
      const imagePath = path.join(this.cacheDir, `${cacheKey}.webp`);
      const metadataPath = path.join(this.cacheDir, `${cacheKey}.${this.#uploadScope}.json`);
      const cached = await readCachedUpload(metadataPath, cacheKey, this.#uploadScope);
      if (cached) return { url: cached.ghostUrl, alt: cached.alt };

      let imageBytes: Uint8Array | undefined = await readOptional(imagePath);
      let alt = heroImageAlt(input);
      if (!imageBytes) {
        this.logger.info({ articleId: article.article_id, cacheKey }, "Generating article hero image");
        const generated = await this.generator.generate(input);
        imageBytes = generated.bytes;
        assertImageSize(imageBytes);
        alt = generated.alt;
        await writeAtomic(imagePath, imageBytes);
      }
      if (!imageBytes) throw new Error("Hero image cache contained no image data");
      assertImageSize(imageBytes);

      this.logger.info({ articleId: article.article_id, cacheKey }, "Uploading article hero image to Ghost");
      const image = await this.ghost.uploadImage({
        bytes: imageBytes,
        filename: `playroom-${safeId(article.article_id)}-${this.#uploadScope}-${cacheKey.slice(0, 12)}.webp`,
        contentType: "image/webp",
        ref: `playroom-hero-${this.#uploadScope}-${cacheKey}`,
      });
      assertHttpUrl(image.url);
      const metadata: CachedUpload = {
        version: 1,
        cacheKey,
        ghostUrl: image.url,
        alt,
        uploadScope: this.#uploadScope,
      };
      await writeAtomic(metadataPath, Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"));
      return { url: image.url, alt };
    });
  }
}

function promptInput(article: Article): HeroImagePromptInput {
  return {
    articleId: article.article_id,
    locale: stringCell(article.locale),
    title: stringCell(article.title),
    topic: stringCell(article.topic) || stringCell(article.primary_keyword) || stringCell(article.title),
    primaryKeyword: stringCell(article.primary_keyword),
    excerpt: stringCell(article.excerpt),
  };
}

async function readCachedUpload(
  metadataPath: string,
  cacheKey: string,
  uploadScope: string,
): Promise<CachedUpload | undefined> {
  const bytes = await readOptional(metadataPath);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<CachedUpload>;
    if (
      value.version !== 1 ||
      value.cacheKey !== cacheKey ||
      value.uploadScope !== uploadScope ||
      typeof value.ghostUrl !== "string" ||
      typeof value.alt !== "string" ||
      !value.alt.trim()
    ) {
      return undefined;
    }
    assertHttpUrl(value.ghostUrl);
    return value as CachedUpload;
  } catch {
    return undefined;
  }
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(filePath: string, contents: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hero image URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Hero image URL must use HTTP or HTTPS");
}

function assertImageSize(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) throw new Error("Hero image is empty");
  if (bytes.byteLength > MAX_HERO_IMAGE_BYTES) throw new Error("Hero image exceeded the 20 MB safety limit");
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "article";
}
