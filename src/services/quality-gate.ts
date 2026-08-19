import type { AppConfig } from "../config.js";
import type { Article, SheetRecord } from "../domain/article.js";
import {
  booleanCell,
  numberCell,
  parseListCell,
  stringCell,
} from "../domain/article.js";
import type { GoogleSheetsStore } from "../sheets/google-sheets.js";

export type QualityResult = {
  passed: boolean;
  blockers: string[];
  score: number;
};

export class QualityGate {
  constructor(
    private readonly store: GoogleSheetsStore,
    private readonly config: AppConfig,
  ) {}

  async evaluate(article: Article): Promise<QualityResult> {
    const [settings, links] = await Promise.all([
      this.store.getSettings(),
      this.store.listLinks(),
    ]);
    const blockers = new Set<string>();
    const minScore = numberCell(settings.get("qa_min_score")) || 8;
    const score = numberCell(article.quality_score);
    const enabledLocales = parseListCell(settings.get("enabled_locales"));
    const bodyWordCount = article.body_markdown.split(/\s+/).filter(Boolean).length;

    if (!article.article_id || article.article_id.startsWith("EXAMPLE-")) blockers.add("example_or_missing_id");
    if (!enabledLocales.includes(article.locale)) blockers.add("locale_not_enabled");
    if (article.locale === "ru" && !booleanCell(settings.get("ru_enabled"))) blockers.add("ru_disabled");
    if (article.title.length < 10) blockers.add("title_missing_or_short");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) blockers.add("invalid_slug");
    if (bodyWordCount < 500) blockers.add("article_too_short");

    const seoTitle = stringCell(article.seo_title);
    if (!seoTitle || seoTitle.length > 60) blockers.add("invalid_seo_title");
    const meta = stringCell(article.meta_description);
    if (meta.length < 80 || meta.length > 160) blockers.add("invalid_meta_description");

    const sources = parseListCell(article.source_urls);
    if (sources.length === 0 || sources.some((url) => !isHttpUrl(url))) blockers.add("missing_source_url");
    if (sources.some(hasTrackingParameters)) blockers.add("tracking_parameters_in_source_url");

    const requestedInternalLinks = parseListCell(article.internal_links);
    if (requestedInternalLinks.length === 0) blockers.add("missing_internal_link");
    const allowedLinks = new Set(
      links
        .filter((row) => isAllowedLink(row, article.locale, this.config.targetEnvironment))
        .map((row) => normalizeUrl(stringCell(row.url))),
    );
    for (const url of requestedInternalLinks) {
      if (!allowedLinks.has(normalizeUrl(url))) blockers.add("invalid_internal_link");
    }

    const bodyUrls = extractHttpUrls(article.body_markdown);
    if (bodyUrls.some((url) => !allowedLinks.has(normalizeUrl(url)))) {
      blockers.add("external_url_in_body");
    }
    const markdownLinks = new Set(extractMarkdownLinkUrls(article.body_markdown).map(normalizeUrl));
    for (const url of requestedInternalLinks) {
      if (!markdownLinks.has(normalizeUrl(url))) blockers.add("internal_link_not_in_body");
    }
    if (/\]\s*\.\s*\(\s*https?:\/\//iu.test(article.body_markdown)) {
      blockers.add("malformed_markdown_link");
    }

    if (meta && !/[.!?…]$/u.test(meta)) blockers.add("meta_description_incomplete");

    if (booleanCell(article.manual_required)) blockers.add("manual_required");
    if (score < minScore) blockers.add("quality_score_below_threshold");

    return { passed: blockers.size === 0, blockers: [...blockers].sort(), score };
  }
}

function isAllowedLink(row: SheetRecord, locale: string, environment: string): boolean {
  return (
    stringCell(row.environment) === environment &&
    [locale, "all"].includes(stringCell(row.locale)) &&
    stringCell(row.status) === "active" &&
    booleanCell(row.allow_internal_link)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function hasTrackingParameters(value: string): boolean {
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].some((key) =>
      /^(?:utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid)$/iu.test(key),
    );
  } catch {
    return false;
  }
}

function extractHttpUrls(markdown: string): string[] {
  return [...markdown.matchAll(/https?:\/\/[^\s<>)\]}]+/giu)].map((match) => match[0]);
}

function extractMarkdownLinkUrls(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]\n]+\]\(\s*(https?:\/\/[^\s)]+)\s*\)/giu)].map(
    (match) => match[1]!,
  );
}
