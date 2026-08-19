import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Article } from "../domain/article.js";
import { dateCell, parseListCell, stringCell } from "../domain/article.js";
import type { GhostPostInput } from "./client.js";

const LOCALE_MAPPING: Record<string, { tag: string; publicPrefix: string }> = {
  en: { tag: "en", publicPrefix: "en" },
  sr: { tag: "rs", publicPrefix: "rs" },
  ru: { tag: "ru", publicPrefix: "ru" },
};

export async function buildGhostPayload(
  article: Article,
  status: GhostPostInput["status"],
  timeZone = "Europe/Belgrade",
): Promise<GhostPostInput> {
  const locale = LOCALE_MAPPING[article.locale];
  if (!locale) throw new Error(`Unsupported locale: ${article.locale}`);
  const baseSlug = baseArticleSlug(article.slug, locale.tag);
  const rawHtml = await marked.parse(article.body_markdown, { gfm: true });
  const html = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "figure", "figcaption"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  });

  const tags = new Set([locale.tag, ...parseListCell(article.tags)]);
  const payload: GhostPostInput = {
    title: article.title,
    slug: `${baseSlug}-${locale.tag}`,
    html,
    status,
    tags: [...tags].map((name) => ({ name })),
  };
  assignIfPresent(payload, "custom_excerpt", stringCell(article.excerpt));
  assignIfPresent(payload, "meta_title", stringCell(article.seo_title));
  assignIfPresent(payload, "meta_description", stringCell(article.meta_description));
  assignIfPresent(payload, "feature_image", stringCell(article.feature_image_url));
  assignIfPresent(payload, "feature_image_alt", stringCell(article.feature_image_alt));
  if (status === "scheduled") {
    const scheduledAt = dateCell(article.scheduled_publish_at, timeZone);
    if (!scheduledAt) throw new Error("Scheduled Ghost post requires scheduled_publish_at");
    payload.published_at = scheduledAt.toISOString();
  }
  return payload;
}

export function publicArticleUrl(frontendBaseUrl: string, article: Article): string {
  const locale = LOCALE_MAPPING[article.locale];
  if (!locale) throw new Error(`Unsupported locale: ${article.locale}`);
  const baseSlug = baseArticleSlug(article.slug, locale.tag);
  return `${frontendBaseUrl.replace(/\/$/, "")}/${locale.publicPrefix}/blog/${baseSlug}`;
}

export function ghostArticleSlug(article: Article): string {
  const locale = LOCALE_MAPPING[article.locale];
  if (!locale) throw new Error(`Unsupported locale: ${article.locale}`);
  return `${baseArticleSlug(article.slug, locale.tag)}-${locale.tag}`;
}

function baseArticleSlug(slug: string, localeTag: string): string {
  const trimmed = slug.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  return trimmed.endsWith(`-${localeTag}`) ? trimmed.slice(0, -(localeTag.length + 1)) : trimmed;
}

function assignIfPresent<K extends keyof GhostPostInput>(
  target: GhostPostInput,
  key: K,
  value: string,
): void {
  if (value) target[key] = value as GhostPostInput[K];
}
