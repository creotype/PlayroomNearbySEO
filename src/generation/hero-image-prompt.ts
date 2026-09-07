import { createHash } from "node:crypto";

export const HERO_IMAGE_PROMPT_VERSION = "playroom-hero-v1";

export type HeroImagePromptInput = {
  articleId: string;
  locale: string;
  title: string;
  topic: string;
  primaryKeyword: string;
  excerpt: string;
};

const PLAYROOM_VISUAL_GUIDE = [
  "Create exactly one premium landscape editorial illustration for a Playroom article for parents and children.",
  "Use a warm, optimistic visual language with a dominant orange and yellow palette: tangerine, amber, sunflower, warm cream, and soft golden light. Muted navy, teal, or warm brown may appear only as supporting accents.",
  "Use layered paper-cut forms and softly modelled 3D shapes, rounded geometry, tactile materials, gentle depth, and a clean composition.",
  "Depict one clear, topic-specific focal scene. Keep generous breathing room around the subject so the image works as a website hero crop.",
  "The result should feel friendly and trustworthy, not infantile, chaotic, generic, or excessively saturated.",
  "Do not render any words, letters, numbers, captions, signs, logos, brands, or watermarks.",
  "Do not show identifiable faces. If people are useful, show them from behind, at a distance, as simplified silhouettes, or cropped so faces are not visible.",
  "Do not imply a real venue identity, address, price, certification, rating, or other factual claim.",
  "No photorealistic identifiable children, celebrities, unsafe activity, injury, fear, weapons, alcohol, tobacco, adult themes, collage, split screen, border, or mockup frame.",
] as const;

export function buildHeroImagePrompt(input: HeroImagePromptInput): string {
  return [
    `Prompt version: ${HERO_IMAGE_PROMPT_VERSION}`,
    ...PLAYROOM_VISUAL_GUIDE,
    "",
    "Article context (use only to choose the scene; never copy this text into the image):",
    `Language/locale: ${normalized(input.locale)}`,
    `Title: ${normalized(input.title)}`,
    `Subject: ${normalized(input.topic)}`,
    `Primary keyword: ${normalized(input.primaryKeyword)}`,
    `Summary: ${normalized(input.excerpt)}`,
  ].join("\n");
}

export function heroImageAlt(input: HeroImagePromptInput): string {
  const subject = truncate(normalized(input.topic) || normalized(input.title), 92);
  if (input.locale.toLowerCase() === "ru") return `Тематическая иллюстрация: ${subject}`;
  if (input.locale.toLowerCase() === "sr") return `Tematska ilustracija: ${subject}`;
  return `Editorial illustration: ${subject}`;
}

export function heroImagePromptHash(
  input: HeroImagePromptInput,
  settings: { model: string; size: string; quality: string },
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      promptVersion: HERO_IMAGE_PROMPT_VERSION,
      model: settings.model,
      size: settings.size,
      quality: settings.quality,
      prompt: buildHeroImagePrompt(input),
    }))
    .digest("hex");
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const shortened = value.slice(0, maxLength - 1).replace(/\s+\S*$/u, "").trimEnd();
  return `${shortened || value.slice(0, maxLength - 1)}…`;
}
