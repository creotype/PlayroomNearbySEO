import { describe, expect, it } from "vitest";
import { articleContentHash, dateCell, displayDateCell, type SheetRecord } from "../src/domain/article.js";

function article(overrides: Partial<SheetRecord> = {}): SheetRecord {
  return {
    __rowNumber: 2,
    locale: "sr",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    excerpt: "Praktičan vodič za roditelje.",
    seo_title: "Kako izabrati igraonicu u Beogradu",
    meta_description: "Praktičan vodič za izbor dečije igraonice u Beogradu za različite uzraste i potrebe porodice.",
    body_markdown: "## Uvod\n\nTekst članka.",
    tags: "rs",
    source_urls: "https://example.com/source",
    internal_links: "https://example.com/rs/blog",
    feature_image_url: "",
    feature_image_alt: "",
    scheduled_publish_at: "",
    ...overrides,
  };
}

describe("articleContentHash", () => {
  it("is stable across non-publishable workflow changes", () => {
    expect(articleContentHash(article({ status: "needs_review" }))).toBe(
      articleContentHash(article({ status: "approved", approved_by: "telegram:1" })),
    );
  });

  it("changes when manually edited publishable content changes", () => {
    expect(articleContentHash(article())).not.toBe(
      articleContentHash(article({ body_markdown: "## Uvod\n\nIzmenjen tekst." })),
    );
  });

  it("normalizes Windows newlines and surrounding whitespace", () => {
    expect(articleContentHash(article({ body_markdown: "  A\r\nB  " }))).toBe(
      articleContentHash(article({ body_markdown: "A\nB" })),
    );
  });
});

describe("dateCell", () => {
  it("converts a Google serial from the spreadsheet timezone", () => {
    expect(dateCell(46253.544444444444)?.toISOString()).toBe("2026-08-19T11:04:00.000Z");
  });

  it("parses localized and ISO wall-clock values consistently", () => {
    expect(dateCell("19.08.2026 13:04")?.toISOString()).toBe("2026-08-19T11:04:00.000Z");
    expect(dateCell("2026-08-19 13:04")?.toISOString()).toBe("2026-08-19T11:04:00.000Z");
    expect(dateCell("2026-08-19T13:04:00+02:00")?.toISOString()).toBe("2026-08-19T11:04:00.000Z");
  });

  it("formats a serial for Telegram in local time", () => {
    expect(displayDateCell(46253.544444444444)).toContain("13:04");
  });
});
