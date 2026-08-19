import { describe, expect, it } from "vitest";
import { prepareSheetValue } from "../src/sheets/google-sheets.js";

describe("prepareSheetValue", () => {
  it("converts ISO timestamps to Google serial dates in the Sheet timezone", () => {
    expect(prepareSheetValue("updated_at", "2026-08-19T11:04:00.000Z")).toBeCloseTo(
      46253.544444444444,
      8,
    );
  });

  it("keeps formula-looking user text as text for RAW writes", () => {
    const value = "=IMPORTXML(\"https://example.com\", \"//x\")";
    expect(prepareSheetValue("feedback", value)).toBe(value);
  });
});
