import OpenAI from "openai";
import {
  buildHeroImagePrompt,
  heroImageAlt,
  heroImagePromptHash,
  type HeroImagePromptInput,
} from "./hero-image-prompt.js";

export type HeroImageQuality = "low" | "medium" | "high" | "auto";
export const MAX_HERO_IMAGE_BYTES = 20 * 1024 * 1024;

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

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly size: string,
    private readonly quality: HeroImageQuality,
    client?: ImageClient,
  ) {
    // A lost response after a completed render can make an SDK retry bill a
    // second image. Fail visibly instead; the durable cache handles safe retries
    // after a response was received.
    this.#client = client ?? new OpenAI({ apiKey, maxRetries: 0, timeout: 5 * 60_000 });
  }

  cacheKey(input: HeroImagePromptInput): string {
    return heroImagePromptHash(input, {
      model: this.model,
      size: this.size,
      quality: this.quality,
    });
  }

  async generate(input: HeroImagePromptInput): Promise<GeneratedHeroImage> {
    const response = await this.#client.images.generate({
      model: this.model,
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
