import { describe, expect, it } from "vitest";
import type { Article } from "../src/domain/article.js";
import { buildGhostPayload, ghostArticleSlug, publicArticleUrl } from "../src/ghost/payload.js";

function article(overrides: Partial<Article> = {}): Article {
  return {
    __rowNumber: 2,
    article_id: "SEO-1",
    locale: "sr",
    status: "approved",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "## Vodič\n\n<script>alert('x')</script>Bezbedan tekst sa [linkom](https://example.com).",
    tags: "guide,rs",
    excerpt: "Praktičan vodič",
    seo_title: "Kako izabrati igraonicu",
    meta_description: "Praktičan vodič za roditelje koji biraju dečiju igraonicu u Beogradu prema uzrastu i potrebama deteta.",
    feature_image_url: "https://example.com/image.jpg",
    feature_image_alt: "Dečija igraonica",
    ...overrides,
  };
}

describe("Ghost payload", () => {
  it("maps Serbian public routes to rs while preserving a base slug", async () => {
    const source = article();
    expect(ghostArticleSlug(source)).toBe("kako-izabrati-igraonicu-rs");
    expect(publicArticleUrl("https://beaver.run.place/", source)).toBe(
      "https://beaver.run.place/rs/blog/kako-izabrati-igraonicu",
    );
    expect(ghostArticleSlug(article({ slug: "kako-izabrati-igraonicu-rs" }))).toBe(
      "kako-izabrati-igraonicu-rs",
    );
  });

  it("sanitizes generated Markdown and maps SEO fields", async () => {
    const payload = await buildGhostPayload(article(), "draft");
    expect(payload.html).toContain("<h2>Vodič</h2>");
    expect(payload.html).not.toContain("<script>");
    expect(payload.slug).toBe("kako-izabrati-igraonicu-rs");
    expect(payload.tags.map((tag) => tag.name)).toEqual(expect.arrayContaining(["rs", "guide"]));
    expect(payload.meta_title).toBe("Kako izabrati igraonicu");
  });

  it("requires a time for a scheduled post", async () => {
    await expect(buildGhostPayload(article(), "scheduled")).rejects.toThrow(
      "scheduled_publish_at",
    );
  });
});
