import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "../src/domain/transitions.js";

describe("article transitions", () => {
  it("allows human review to approval and publishing claim", () => {
    expect(canTransition("needs_review", "approved")).toBe(true);
    expect(canTransition("approved", "publishing")).toBe(true);
    expect(canTransition("publishing", "published")).toBe(true);
  });

  it("does not allow direct publication from review", () => {
    expect(canTransition("needs_review", "published")).toBe(false);
    expect(() => assertTransition("needs_review", "published")).toThrow(
      "Invalid article transition",
    );
  });

  it("requires a re-review after a content conflict", () => {
    expect(canTransition("conflict", "needs_review")).toBe(true);
    expect(canTransition("conflict", "publishing")).toBe(false);
  });

  it("allows a stale pre-Ghost publishing lease to reset safely", () => {
    expect(canTransition("publishing", "approved")).toBe(true);
  });
});
