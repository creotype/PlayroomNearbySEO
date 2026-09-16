import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import {
  buildHeroImagePrompt,
  heroImageAlt,
  heroImagePromptHash,
  type HeroImagePromptInput,
} from "./hero-image-prompt.js";

export type HeroImageQuality = "low" | "medium" | "high" | "auto";
export const MAX_HERO_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_LEO_REFERENCE_PATHS = [
  path.resolve("assets", "mascot", "leo", "leo-reference-primary.png"),
  path.resolve("assets", "mascot", "leo", "leo-reference-map.png"),
] as const;

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export type GeneratedHeroImage = {
  bytes: Uint8Array;
  contentType: "image/webp";
  extension: "webp";
  alt: string;
};

export interface HeroImageGenerator {
  cacheKey(input: HeroImagePromptInput): string;
  generate(input: HeroImagePromptInput): Promise<GeneratedHeroImage>;
}

type ImageClient = Pick<OpenAI, "images">;

export class OpenAiHeroImageGenerator implements HeroImageGenerator {
  readonly #client: ImageClient;
  readonly #references: readonly LeoReference[];
  readonly #referenceSetHash: string;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly size: string,
    private readonly quality: HeroImageQuality,
    client?: ImageClient,
    referenceImagePaths: readonly string[] = DEFAULT_LEO_REFERENCE_PATHS,
  ) {
    // A lost response after a completed render can make an SDK retry bill a
    // second image. Fail visibly instead; the durable cache handles safe retries
    // after a response was received.
    this.#client = client ?? new OpenAI({ apiKey, maxRetries: 0, timeout: 5 * 60_000 });
    this.#references = loadLeoReferences(referenceImagePaths);
    this.#referenceSetHash = referenceSetHash(this.#references);
  }

  cacheKey(input: HeroImagePromptInput): string {
    return heroImagePromptHash(input, {
      model: this.model,
      size: this.size,
      quality: this.quality,
      referenceSetHash: this.#referenceSetHash,
    });
  }

  async generate(input: HeroImagePromptInput): Promise<GeneratedHeroImage> {
    const references = await Promise.all(
      this.#references.map((reference) =>
        toFile(reference.bytes, reference.filename, { type: reference.contentType })
      ),
    );
    const response = await this.#client.images.edit({
      model: this.model,
      image: references,
      prompt: buildHeroImagePrompt(input),
      n: 1,
      size: this.size,
      quality: this.quality,
      output_format: "webp",
      output_compression: 90,
      background: "opaque",
    });
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new Error("OpenAI image response contained no image data");
    const maxEncodedLength = Math.ceil((MAX_HERO_IMAGE_BYTES * 4) / 3) + 4;
    if (encoded.length > maxEncodedLength) {
      throw new Error("OpenAI image response exceeded the 20 MB safety limit");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0) throw new Error("OpenAI image response decoded to an empty image");
    if (bytes.length > MAX_HERO_IMAGE_BYTES) {
      throw new Error("OpenAI image response exceeded the 20 MB safety limit");
    }
    return {
      bytes,
      contentType: "image/webp",
      extension: "webp",
      alt: heroImageAlt(input),
    };
  }
}

type LeoReference = {
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
};

function loadLeoReferences(referenceImagePaths: readonly string[]): readonly LeoReference[] {
  if (referenceImagePaths.length === 0) {
    throw new Error("At least one Leo reference image is required");
  }
  return referenceImagePaths.map((filePath) => {
    const filename = path.basename(filePath);
    const contentType = referenceContentType(filename);
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`Leo reference image is missing: ${filename}`);
      throw error;
    }
    if (bytes.byteLength === 0) throw new Error(`Leo reference image is empty: ${filename}`);
    if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`Leo reference image exceeds the 20 MB safety limit: ${filename}`);
    }
    assertImageSignature(bytes, contentType, filename);
    return { filename, contentType, bytes };
  });
}

function referenceContentType(filename: string): LeoReference["contentType"] {
  switch (path.extname(filename).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: throw new Error(`Unsupported Leo reference image format: ${filename}`);
  }
}

function assertImageSignature(
  bytes: Buffer,
  contentType: LeoReference["contentType"],
  filename: string,
): void {
  const valid = contentType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : contentType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new Error(`Leo reference image content does not match its file format: ${filename}`);
}

function referenceSetHash(references: readonly LeoReference[]): string {
  const hash = createHash("sha256");
  for (const reference of references) {
    hash.update(reference.filename).update("\0").update(reference.bytes).update("\0");
  }
  return hash.digest("hex");
}
