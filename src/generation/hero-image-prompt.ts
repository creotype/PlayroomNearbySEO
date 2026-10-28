import { createHash } from "node:crypto";

export const HERO_IMAGE_PROMPT_VERSION = "playroom-hero-v2-leo";

export type HeroImagePromptInput = {
  articleId: string;
  locale: string;
  title: string;
  topic: string;
  primaryKeyword: string;
  excerpt: string;
};

const PLAYROOM_VISUAL_GUIDE = [
  "Use case: stylized-concept. Asset type: premium landscape blog header for a Playroom article for parents and children.",
  "The supplied images are character references, not edit targets: Image 1 is the canonical identity reference for Leo; Image 2 is a secondary identity and natural-action reference.",
  "Show exactly one Leo as the main character in every image. Preserve the same friendly golden-yellow lion cub, rounded proportions, symmetrical petal-shaped orange mane, large dark-brown eyes, warm-brown eyebrows, rounded ears with orange inner ears, small dark nose, pale cream muzzle, cheek whisker marks, orange tail tuft, and friendly expression from the references.",
  "Preserve Leo's dark navy hoodie with hood down, white drawstrings, kangaroo pocket, ribbed cuffs and hem, plus the small orange map-pin emblem with a navy heart on his chest. Keep his golden legs and paws bare: no trousers and no shoes. The chest emblem is the only permitted brand mark.",
  "Keep Leo recognizably the same character; do not redesign him as a human, realistic animal, flat icon, different lion, or generic mascot.",
  "Create a new topic-specific scene and adapt Leo's pose, expression, action, and props to the article. Do not copy the white reference background, the map, or a reference pose unless it suits the topic. Graphics printed on the reference map are incidental prop details and must never be copied; only Leo's chest emblem is canonical.",
  "Use a warm, optimistic visual language with a dominant orange and yellow palette: tangerine, amber, sunflower, warm cream, and soft golden light. Leo's hoodie must remain dark navy; elsewhere navy, teal, or warm brown may appear only as supporting accents.",
  "Match Leo's polished softly modelled 3D mascot style and tactile fur/fabric texture. Build the surrounding scene from layered paper-cut forms and softly modelled 3D shapes with rounded geometry and gentle depth.",
  "Depict one clear, topic-specific focal scene with Leo actively participating. Keep generous breathing room around the subject so the image works as a website hero crop.",
  "The result should feel friendly and trustworthy, not infantile, chaotic, generic, or excessively saturated.",
  "Do not render any words, letters, numbers, captions, signs, other logos, other brands, or watermarks.",
  "Leo's face must remain clearly visible and consistent. Do not show identifiable human faces; if people are useful, show them from behind, at a distance, as simplified silhouettes, or cropped so faces are not visible.",
  "Do not imply a real venue identity, address, price, certification, rating, or other factual claim.",
  "No duplicate Leo, additional lion mascots, photorealistic identifiable children, celebrities, unsafe activity, injury, fear, weapons, alcohol, tobacco, adult themes, collage, split screen, border, or mockup frame.",
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
  settings: { model: string; size: string; quality: string; referenceSetHash: string },
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      promptVersion: HERO_IMAGE_PROMPT_VERSION,
      model: settings.model,
      size: settings.size,
      quality: settings.quality,
      referenceSetHash: settings.referenceSetHash,
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
