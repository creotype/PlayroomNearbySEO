import { describe, expect, it } from "vitest";
import { articleContentHash, type SheetRecord } from "../src/domain/article.js";
import { hasRecoverableSystemExhaustionGate } from "../src/services/system-gate-recovery.js";

function fixture(manualRequiredBeforeAttempt: boolean | undefined) {
  const article: SheetRecord = {
    __rowNumber: 8,
    article_id: "SEO-1",
    status: "failed_qa",
    qa_status: "fail",
    qa_blockers: "editor_feedback_not_applied",
    manual_required: true,
    locale: "en",
    title: "Title",
    slug: "title",
    body_markdown: "Body",
  };
  const outputHash = articleContentHash(article);
  const startedPayload: Record<string, unknown> = { input_hash: "old-hash" };
  if (manualRequiredBeforeAttempt !== undefined) {
    startedPayload.manual_required_before_attempt = manualRequiredBeforeAttempt;
  }
  const started: SheetRecord = {
    __rowNumber: 20,
    article_id: "SEO-1",
    event_id: "evt-started",
    event_type: "auto_qa_repair_started",
    actor_type: "system",
    actor_id: "auto-qa-repair",
    provider: "openai",
    provider_object_id: "auto-qa-repair:one",
    payload_json: JSON.stringify(startedPayload),
  };
  const terminal: SheetRecord = {
    __rowNumber: 22,
    article_id: "SEO-1",
    event_id: "evt-terminal",
    event_type: "auto_qa_repair_exhausted",
    actor_type: "system",
    actor_id: "auto-qa-repair",
    provider: "system",
    provider_object_id: "auto-qa-repair:one",
    payload_json: JSON.stringify({
      output_hash: outputHash,
      qa_blockers: "editor_feedback_not_applied",
      started_event_id: "evt-started",
    }),
  };
  const notified: SheetRecord = {
    __rowNumber: 23,
    article_id: "SEO-1",
    event_id: "evt-notified",
    event_type: "auto_qa_repair_notified",
    actor_type: "system",
    actor_id: "auto-qa-repair",
    provider: "telegram",
    payload_json: JSON.stringify({ terminal_event_id: "evt-terminal" }),
  };
  return { article, outputHash, started, terminal, notified };
}

describe("hasRecoverableSystemExhaustionGate", () => {
  it("accepts only a linked system gate whose pre-attempt manual flag was false", () => {
    const test = fixture(false);
    expect(hasRecoverableSystemExhaustionGate(
      test.article,
      [test.started, test.terminal, test.notified],
      test.outputHash,
    )).toBe(true);
  });

  it.each([true, undefined])(
    "preserves an existing or unproven manual gate (snapshot %s)",
    (snapshot) => {
      const test = fixture(snapshot);
      expect(hasRecoverableSystemExhaustionGate(
        test.article,
        [test.started, test.terminal],
        test.outputHash,
      )).toBe(false);
    },
  );

  it("rejects an exhausted event without trusted auto-repair provenance", () => {
    const test = fixture(false);
    test.terminal.actor_id = "operator-repair";
    expect(hasRecoverableSystemExhaustionGate(
      test.article,
      [test.started, test.terminal],
      test.outputHash,
    )).toBe(false);
  });

  it("rejects any later human activity", () => {
    const test = fixture(false);
    const humanEvent: SheetRecord = {
      __rowNumber: 24,
      article_id: "SEO-1",
      event_id: "evt-human",
      event_type: "feedback_received",
      actor_type: "human",
      actor_id: "42",
      provider: "telegram",
      payload_json: "{}",
    };
    expect(hasRecoverableSystemExhaustionGate(
      test.article,
      [test.started, test.terminal, humanEvent],
      test.outputHash,
    )).toBe(false);
  });
});
