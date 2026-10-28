import { describe, expect, it } from "vitest";
import {
  canonicalInternalUrl,
  canonicalizeInternalUrlsInMarkdown,
  LEGACY_SERBIAN_HOME_URL,
  PRODUCTION_SERBIAN_HOME_URL,
} from "../src/domain/internal-links.js";

describe("Serbian internal-link policy", () => {
  it("maps the obsolete Serbian home URL to the canonical product domain", () => {
    expect(canonicalInternalUrl("sr", LEGACY_SERBIAN_HOME_URL)).toBe(
      PRODUCTION_SERBIAN_HOME_URL,
    );
    expect(canonicalInternalUrl("sr", `${LEGACY_SERBIAN_HOME_URL}/?utm_source=old`)).toBe(
      PRODUCTION_SERBIAN_HOME_URL,
    );
  });

  it("rewrites the obsolete home CTA in Markdown without changing blog URLs", () => {
    const body = [
      `[Istražite Playroom](${LEGACY_SERBIAN_HOME_URL}).`,
      `[Stari parametrizovani CTA](http://playroom-kids.app/rs/?utm_source=old#cta).`,
      `[Blog](${LEGACY_SERBIAN_HOME_URL}/blog).`,
      `[Druga putanja](${LEGACY_SERBIAN_HOME_URL}.html).`,
    ].join("\n");

    expect(canonicalizeInternalUrlsInMarkdown("sr", body)).toBe([
      `[Istražite Playroom](${PRODUCTION_SERBIAN_HOME_URL}).`,
      `[Stari parametrizovani CTA](${PRODUCTION_SERBIAN_HOME_URL}).`,
      `[Blog](${LEGACY_SERBIAN_HOME_URL}/blog).`,
      `[Druga putanja](${LEGACY_SERBIAN_HOME_URL}.html).`,
    ].join("\n"));
  });

  it("does not alter another locale", () => {
    expect(canonicalInternalUrl("en", LEGACY_SERBIAN_HOME_URL)).toBe(
      LEGACY_SERBIAN_HOME_URL,
    );
  });
});
