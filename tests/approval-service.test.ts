import { describe, expect, it } from "vitest";
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

function setup(quality: QualityResult, schedulePolicy?: ApprovalSchedulePolicy) {
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
  const gate = { evaluate: async () => quality };
  return {
    service: new ApprovalService(
      store as unknown as GoogleSheetsStore,
      gate as unknown as QualityGate,
      new KeyedMutex(),
      schedulePolicy,
    ),
    current: () => current,
    events,
  };
}

describe("ApprovalService", () => {
  it("records a hash-bound Telegram approval", async () => {
    const test = setup({ passed: true, blockers: [], score: 9 });
    const expectedHash = articleContentHash(test.current());
    const result = await test.service.approve("SEO-1", actor);
    expect(result.outcome).toBe("approved");
    expect(test.current().status).toBe("approved");
    expect(test.current().qa_status).toBe("pass");
    expect(test.current().qa_blockers).toBe("");
    expect(test.current().content_hash).toBe(expectedHash);
    expect(test.events).toHaveLength(1);
    expect(JSON.parse(String(test.events[0]?.payload_json))).toMatchObject({ hash: expectedHash });
  });

  it("keeps the article in review when deterministic QA blocks approval", async () => {
    const test = setup({ passed: false, blockers: ["missing_source_url"], score: 7 });
    const result = await test.service.approve("SEO-1", actor);
    expect(result.outcome).toBe("blocked");
    expect(test.current().status).toBe("needs_review");
    expect(test.current().qa_status).toBe("fail");
    expect(test.current().qa_blockers).toBe("missing_source_url");
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
