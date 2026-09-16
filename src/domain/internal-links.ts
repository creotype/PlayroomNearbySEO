export const PRODUCTION_SERBIAN_HOME_URL = "https://playroom-kids.rs/rs";
export const LEGACY_SERBIAN_HOME_URL = "https://playroom-kids.app/rs";

/**
 * Keep the Serbian product CTA deterministic even if an obsolete Sheet row is
 * accidentally reactivated. Other locales and URLs remain Sheet-controlled.
 */
export function canonicalInternalUrl(locale: string, value: string): string {
  const trimmed = value.trim();
  if (locale.trim().toLowerCase() !== "sr") return trimmed;
  return isLegacySerbianHomeUrl(trimmed) ? PRODUCTION_SERBIAN_HOME_URL : trimmed;
}

export function canonicalizeInternalUrlsInMarkdown(locale: string, markdown: string): string {
  if (locale.trim().toLowerCase() !== "sr") return markdown;
  return markdown.replace(
    /(\]\(\s*)(https?:\/\/[^\s)]+)(\s*\))/giu,
    (match, prefix: string, url: string, suffix: string) => {
      const canonical = canonicalInternalUrl(locale, url);
      return canonical === url ? match : `${prefix}${canonical}${suffix}`;
    },
  );
}

function isLegacySerbianHomeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "playroom-kids.app" &&
      url.pathname.replace(/\/+$/u, "") === "/rs"
    );
  } catch {
    return false;
  }
}
