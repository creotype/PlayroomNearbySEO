import { describe, expect, it, vi } from "vitest";
import type { Article } from "../src/domain/article.js";
import { articleContentHash } from "../src/domain/article.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import {
  ApprovalService,
  type ApprovalSchedulePolicy,
  type TelegramActor,
} from "../src/services/approval-service.js";
import type { QualityGate, QualityResult } from "../src/services/quality-gate.js";

const actor: TelegramActor = {
  id: 42,
  username: "owner",
  displayName: "Owner",
  providerObjectId: "message:-100:10",
};

function article(): Article {
  return {
    __rowNumber: 2,
    article_id: "SEO-1",
    locale: "sr",
    status: "needs_review",
    title: "Kako izabrati igraonicu",
    slug: "kako-izabrati-igraonicu",
    body_markdown: "Dovoljno dugačak tekst",
    excerpt: "Vodič",
    seo_title: "Kako izabrati igraonicu",
    meta_description: "Opis",
    tags: "rs",
    source_urls: "https://example.com/source",
    internal_links: "https://example.com/rs/blog",
    quality_score: 9,
    qa_status: "pass",
    qa_blockers: "",
    manual_required: false,
  };
}

function setup(
  quality: QualityResult | ((current: Article) => QualityResult),
  schedulePolicy?: ApprovalSchedulePolicy,
  changeDuringEvaluation?: (current: Article) => Article,
) {
  let current = article();
  const events: Array<Record<string, unknown>> = [];
  const store = {
    getSettings: async () => new Map([
      ["timezone", schedulePolicy?.timeZone ?? "Europe/Belgrade"],
      ["publication_time", schedulePolicy?.publicationTime ?? "10:00"],
    ]),
    findArticle: async () => current,
    listEvents: async () => events,
    patchArticle: async (_id: string, patch: Record<string, unknown>) => {
      current = { ...current, ...patch } as Article;
      return current;
    },
    appendEvent: async (event: Record<string, unknown>) => {
      events.push({ ...event, __rowNumber: events.length + 2 });
    },
    patchArticleAndAppendEvent: async (
      _id: string,
      patch: Record<string, unknown>,
      event: Record<string, unknown>,
    ) => {
      current = { ...current, ...patch } as Article;
      events.push({ ...event, __rowNumber: events.length + 2 });
      return current;
    },
  };
  const evaluate = vi.fn(async (candidate: Article) => {
      if (changeDuringEvaluation) current = changeDuringEvaluation(current);
      return typeof quality === "function" ? quality(candidate) : quality;
  });
  const gate = { evaluate };
  return {
    service: new ApprovalService(
      store as unknown as GoogleSheetsStore,
      gate as unknown as QualityGate,
      new KeyedMutex(),
      schedulePolicy,
    ),
    current: () => current,
    patchExternally: (patch: Partial<Article>) => {
      current = { ...current, ...patch } as Article;
    },
    evaluate,
    events,
  };
}

describe("ApprovalService", () => {
  it("records a hash-bound Telegram approval", async () => {
    const test = setup({ passed: true, blockers: [], score: 9.4 });
    const expectedHash = articleContentHash(test.current());
    const result = await test.service.approve("SEO-1", actor);
    expect(result.outcome).toBe("approved");
    expect(test.current().status).toBe("approved");
    expect(test.current().qa_status).toBe("pass");
    expect(test.current().qa_blockers).toBe("");
    expect(test.current().quality_score).toBe(9.4);
    expect(test.current().content_hash).toBe(expectedHash);
    expect(test.events).toHaveLength(1);
    expect(JSON.parse(String(test.events[0]?.payload_json))).toMatchObject({ hash: expectedHash });
  });

  it("atomically moves the article to failed QA when deterministic QA blocks approval", async () => {
    const test = setup({ passed: false, blockers: ["missing_source_url"], score: 7 });
    const result = await test.service.approve("SEO-1", actor);
    expect(result.outcome).toBe("blocked");
    expect(test.current().status).toBe("failed_qa");
    expect(test.current().qa_status).toBe("fail");
    expect(test.current().qa_blockers).toBe("missing_source_url");
    expect(test.current().quality_score).toBe(7);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({
      event_type: "approval_blocked",
      from_status: "needs_review",
      to_status: "failed_qa",
    });
    expect(JSON.parse(String(test.events[0]?.payload_json))).toMatchObject({
      hash: articleContentHash(article()),
      blockers: ["missing_source_url"],
      score: 7,
    });

    const repeated = await test.service.approve("SEO-1", {
      ...actor,
      providerObjectId: "message:-100:11",
    });
    expect(repeated.outcome).toBe("blocked");
    expect(test.evaluate).toHaveBeenCalledTimes(2);
    expect(test.events).toHaveLength(1);
  });

  it("approves the same draft after an external QA setting is corrected", async () => {
    let linkInventoryFixed = false;
    const test = setup(() => linkInventoryFixed
      ? { passed: true, blockers: [], score: 9 }
      : { passed: false, blockers: ["invalid_internal_link"], score: 9 });

    expect((await test.service.approve("SEO-1", actor)).outcome).toBe("blocked");
    linkInventoryFixed = true;

    const approved = await test.service.approve("SEO-1", {
      ...actor,
      providerObjectId: "message:-100:qa-setting-fixed",
    });

    expect(approved.outcome).toBe("approved");
    expect(test.current().status).toBe("approved");
    expect(test.events.map((event) => event.event_type)).toEqual(["approval_blocked", "approved"]);
  });

  it("re-evaluates and approves a manually corrected failed-QA article", async () => {
    const test = setup((current) =>
      current.body_markdown === "Corrected in Google Sheets"
        ? { passed: true, blockers: [], score: 9 }
        : { passed: false, blockers: ["article_needs_correction"], score: 6 },
    );

    const blocked = await test.service.approve("SEO-1", actor);
    expect(blocked.outcome).toBe("blocked");
    expect(test.current().status).toBe("failed_qa");

    test.patchExternally({ body_markdown: "Corrected in Google Sheets" });
    const approved = await test.service.approve("SEO-1", {
      ...actor,
      providerObjectId: "message:-100:12",
    });

    expect(approved.outcome).toBe("approved");
    expect(test.current().status).toBe("approved");
    expect(test.current().qa_status).toBe("pass");
    expect(test.current().qa_blockers).toBe("");
    expect(test.evaluate).toHaveBeenCalledTimes(2);
    expect(test.events).toHaveLength(2);
    expect(test.events[1]).toMatchObject({
      event_type: "approved",
      from_status: "failed_qa",
      to_status: "approved",
    });
  });

  it("treats explicit human approval as satisfying a manual-required gate", async () => {
    const test = setup((current) =>
      current.manual_required
        ? { passed: false, blockers: ["manual_required"], score: 9 }
        : { passed: true, blockers: [], score: 9 },
    );
    test.patchExternally({
      status: "failed_qa",
      qa_status: "fail",
      qa_blockers: "editor_feedback_not_applied",
      manual_required: true,
      body_markdown: "Human-corrected article",
    });

    const result = await test.service.approve("SEO-1", {
      ...actor,
      providerObjectId: "message:-100:manual-review-complete",
    });

    expect(result.outcome).toBe("approved");
    expect(test.current()).toMatchObject({
      status: "approved",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
    });
    expect(test.evaluate).toHaveBeenCalledWith(expect.objectContaining({ manual_required: false }));
  });

  it.each([
    {
      name: "publishable content",
      change: (current: Article) => ({ ...current, body_markdown: "Edited outside the bot" }),
    },
    {
      name: "status",
      change: (current: Article) => ({ ...current, status: "revision_requested" as const }),
    },
    {
      name: "QA state",
      change: (current: Article) => ({ ...current, qa_status: "fail", qa_blockers: "new_blocker" }),
    },
  ])("does not approve stale article data after an external $name change", async ({ change }) => {
    const test = setup(
      { passed: true, blockers: [], score: 9 },
      undefined,
      change,
    );

    const result = await test.service.approve("SEO-1", actor);

    expect(result.outcome).toBe("stale_article");
    expect(test.current().status).not.toBe("approved");
    expect(test.events).toHaveLength(0);
  });

  it("schedules a human-approved article for the next 10:00 Belgrade and binds approval to that schedule", async () => {
    const test = setup(
      { passed: true, blockers: [], score: 9 },
      {
        timeZone: "Europe/Belgrade",
        publicationTime: "10:00",
        clock: () => new Date("2026-09-07T12:00:00.000Z"), // 14:00 Belgrade
      },
    );

    const result = await test.service.approve("SEO-1", actor);

    expect(result.outcome).toBe("approved");
    expect(test.current().scheduled_publish_at).toBe("2026-09-08T08:00:00.000Z");
    expect(test.current().content_hash).toBe(articleContentHash(test.current()));
    expect(JSON.parse(String(test.events[0]?.payload_json))).toMatchObject({
      hash: test.current().content_hash,
    });
  });
});
