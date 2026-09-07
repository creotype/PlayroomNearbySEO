import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  articleContentHash,
  type Article,
  type CellValue,
  type SheetRecord,
} from "../src/domain/article.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import { AutoQaRepairService } from "../src/services/auto-qa-repair-service.js";
import type {
  GenerationService,
  RegenerationRequest,
  RegenerationResult,
} from "../src/services/generation-service.js";
import { ReviewNotifier } from "../src/services/review-notifier.js";
import type { SeoBot } from "../src/telegram/bot.js";

type RegenerationMode = "pass" | "fail" | "blocked" | "stale" | "throw" | "prepaid_throw";

function repairArticle(overrides: Partial<SheetRecord> = {}): Article {
  const article = {
    __rowNumber: 8,
    article_id: "SEO-REPAIR-1",
    keyword_id: "KW-1",
    locale: "sr",
    status: "needs_review",
    primary_keyword: "igraonice za decu Beograd",
    title: "Kako izabrati igraonicu za decu",
    slug: "kako-izabrati-igraonicu-za-decu",
    excerpt: "Praktičan vodič za izbor igraonice za decu u Beogradu.",
    seo_title: "Kako izabrati igraonicu za decu",
    meta_description: "Praktičan vodič za izbor igraonice za decu u Beogradu, sa korisnim pitanjima za roditelje.",
    body_markdown: "Kratak nacrt koji zahteva doradu.",
    tags: "deca,Beograd",
    source_urls: "https://example.com/source",
    internal_links: "https://example.com/sr",
    feature_image_url: "https://example.com/image.webp",
    feature_image_alt: "Igraonica za decu u toplim bojama",
    scheduled_publish_at: "",
    quality_score: 6,
    qa_status: "fail",
    qa_blockers: "article_too_short",
    manual_required: false,
    revision_count: 0,
    telegram_message_id: 60,
    content_hash: "",
    updated_at: "2026-09-07T08:00:00.000Z",
    ...overrides,
  } as Article;
  article.content_hash = articleContentHash(article);
  return article;
}

function setup(options: {
  article?: Article;
  events?: SheetRecord[];
  mode?: RegenerationMode;
  editMessageText?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
  chatId?: number | null;
} = {}) {
  const article = options.article ?? repairArticle();
  const articles = [article];
  const events = [...(options.events ?? [])];
  const append = (event: Record<string, CellValue>) => {
    events.push({ __rowNumber: events.length + 2, ...event } as SheetRecord);
  };
  const listArticles = vi.fn(async (statuses?: readonly string[]) =>
    articles.filter((candidate) => !statuses || statuses.includes(candidate.status)),
  );
  const patchArticleAndAppendEvent = vi.fn(async (
    articleId: string,
    patch: Record<string, CellValue>,
    event: Record<string, CellValue>,
  ) => {
    const candidate = articles.find((row) => row.article_id === articleId);
    if (!candidate) throw new Error(`Missing article ${articleId}`);
    Object.assign(candidate, patch);
    // Deliberately no mock-level event dedupe: production append is not a CAS.
    append(event);
    return candidate;
  });
  const store = {
    getSettings: async () => new Map<string, CellValue>([
      ["telegram_chat_id", options.chatId === null ? "" : (options.chatId ?? -5484259760)],
    ]),
    listArticles,
    listKeywords: async () => [],
    findArticle: async (articleId: string) =>
      articles.find((candidate) => candidate.article_id === articleId),
    patchArticle: async (articleId: string, patch: Record<string, CellValue>) => {
      const candidate = articles.find((row) => row.article_id === articleId);
      if (!candidate) throw new Error(`Missing article ${articleId}`);
      Object.assign(candidate, patch);
      return candidate;
    },
    listEvents: async (articleId: string) =>
      events.filter((event) => event.article_id === articleId),
    patchArticleAndAppendEvent,
  } as unknown as GoogleSheetsStore;

  const startedWasDurable: boolean[] = [];
  const manualFlagAtCall: CellValue[] = [];
  const mode = options.mode ?? "pass";
  const regenerateArticle = vi.fn(async (request: RegenerationRequest): Promise<RegenerationResult> => {
    startedWasDurable.push(events.some((event) => event.event_type === "auto_qa_repair_started"));
    manualFlagAtCall.push(article.manual_required ?? false);
    if (mode === "prepaid_throw") throw new Error("sheets quota before paid ledger");
    if (mode === "blocked") {
      return { outcome: "blocked", reason: "generator_not_configured", article };
    }
    if (mode === "stale") {
      Object.assign(article, {
        title: "Sveža ručna verzija koja ne sme biti prepisana",
        status: "failed_qa",
        qa_status: "fail",
        qa_blockers: "article_too_short",
        manual_required: false,
        revision_count: 1,
      });
      return { outcome: "blocked", reason: "stale_article", article };
    }
    append({
      event_id: `evt-regeneration-attempt-${events.length}`,
      article_id: article.article_id,
      event_type: "regeneration_attempt_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: `system:${request.providerObjectId}`,
      payload_json: JSON.stringify({ base_hash: articleContentHash(article) }),
      created_at: "2026-09-07T08:00:30.000Z",
    });
    if (mode === "throw") throw new Error("upstream secret detail");

    Object.assign(article, mode === "pass"
      ? {
          status: "needs_review",
          title: "Potpuni vodič za izbor igraonice za decu",
          body_markdown: "Dovoljno dugačak i proveren tekst za roditelje.".repeat(80),
          quality_score: 9,
          qa_status: "pass",
          qa_blockers: "",
          manual_required: false,
          revision_count: 1,
          content_hash: "",
        }
      : {
          status: "failed_qa",
          title: "Druga verzija koja još zahteva proveru",
          body_markdown: "Izmenjen nacrt sa preostalim problemom.",
          quality_score: 7,
          qa_status: "fail",
          qa_blockers: "missing_authoritative_source",
          manual_required: true,
          revision_count: 1,
          content_hash: "",
        });
    append({
      event_id: `evt-regenerated-${events.length}`,
      article_id: article.article_id,
      event_type: "regenerated",
      from_status: "failed_qa",
      to_status: article.status,
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: `system:${request.providerObjectId}`,
      message: "Regenerated",
      payload_json: JSON.stringify({ revision_count: 1 }),
      created_at: "2026-09-07T08:01:00.000Z",
    });
    return { outcome: "regenerated", article };
  });

  const editMessageText = options.editMessageText ?? vi.fn(async (..._args: unknown[]) => true);
  const sendMessage = options.sendMessage ?? vi.fn(async (..._args: unknown[]) => ({ message_id: 61 }));
  const bot = { api: { editMessageText, sendMessage } } as unknown as SeoBot;
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const config = {
    spreadsheetId: "sheet",
    ...(options.chatId === null ? {} : { telegramReviewChatId: options.chatId ?? -5484259760 }),
  } as AppConfig;
  const service = new AutoQaRepairService(
    store,
    { regenerateArticle } as unknown as GenerationService,
    bot,
    config,
    logger,
  );
  return {
    service,
    article,
    events,
    listArticles,
    patchArticleAndAppendEvent,
    store,
    bot,
    config,
    regenerateArticle,
    editMessageText,
    sendMessage,
    logger,
    startedWasDurable,
    manualFlagAtCall,
  };
}

function eventsOf(test: ReturnType<typeof setup>, type: string): SheetRecord[] {
  return test.events.filter((event) => event.event_type === type);
}

function payload(event: SheetRecord): Record<string, unknown> {
  return JSON.parse(String(event.payload_json)) as Record<string, unknown>;
}

describe("AutoQaRepairService", () => {
  it("persists one system attempt before the paid repair and leaves a passing result for review", async () => {
    const test = setup();
    const inputHash = articleContentHash(test.article);

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.listArticles).toHaveBeenCalledWith(["needs_review", "failed_qa"]);
    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(test.startedWasDurable).toEqual([true]);
    expect(test.manualFlagAtCall).toEqual([false]);
    expect(test.regenerateArticle).toHaveBeenCalledWith(expect.objectContaining({
      articleId: "SEO-REPAIR-1",
      actorId: "auto-qa-repair",
      actorName: "auto-qa-repair",
      actorType: "system",
      provider: "system",
      providerObjectId: expect.stringMatching(/^auto-qa-repair:[a-f0-9]{24}$/u),
      expectedContentHash: inputHash,
      requireQaFailure: true,
    }));
    expect(test.article).toMatchObject({
      status: "needs_review",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      telegram_message_id: 60,
      feature_image_url: "https://example.com/image.webp",
    });
    expect(eventsOf(test, "auto_qa_repair_progress")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_started")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(1);
    expect(payload(eventsOf(test, "auto_qa_repair_started")[0]!)).toMatchObject({
      input_hash: inputHash,
      attempt: 1,
      max_attempts: 1,
      manual_required_before_attempt: false,
    });
    expect(test.editMessageText).toHaveBeenCalledTimes(1);
    expect(test.editMessageText).toHaveBeenCalledWith(
      -5484259760,
      60,
      expect.stringContaining("попытка 1 из 1"),
      expect.any(Object),
    );
    expect(String(test.editMessageText.mock.calls[0]?.[2])).not.toContain("article_too_short");
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it("exhausts a failed output once, edits the same message, and closes both hashes", async () => {
    const test = setup({ mode: "fail" });
    const inputHash = articleContentHash(test.article);

    await test.service.runOnce();
    const outputHash = articleContentHash(test.article);
    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(test.article).toMatchObject({
      status: "failed_qa",
      qa_status: "fail",
      manual_required: true,
      telegram_message_id: 60,
    });
    const exhausted = eventsOf(test, "auto_qa_repair_exhausted");
    expect(exhausted).toHaveLength(1);
    expect(payload(exhausted[0]!)).toMatchObject({
      input_hash: inputHash,
      output_hash: outputHash,
      attempt: 1,
      max_attempts: 1,
      outcome: "exhausted",
    });
    expect(eventsOf(test, "auto_qa_repair_notified")).toHaveLength(1);
    expect(test.editMessageText).toHaveBeenCalledTimes(2);
    const warning = String(test.editMessageText.mock.calls[1]?.[2]);
    expect(warning).toContain("/regenerate ваш комментарий");
    expect(warning).toContain(
      "https://docs.google.com/spreadsheets/d/sheet/edit#gid=910000001&amp;range=A8:AO8",
    );
    expect(warning).not.toContain("missing_authoritative_source");
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it("resumes an outer start when no paid-attempt ledger was written", async () => {
    const article = repairArticle({ status: "failed_qa", telegram_message_id: 60 });
    const inputHash = articleContentHash(article);
    const started: SheetRecord = {
      __rowNumber: 20,
      event_id: "evt-auto-started-before-quota-error",
      article_id: article.article_id,
      event_type: "auto_qa_repair_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "openai",
      provider_object_id: "auto-qa-repair:prepaid-recovery",
      payload_json: JSON.stringify({
        input_hash: inputHash,
        hash: inputHash,
        attempt: 1,
      }),
      created_at: "2026-09-07T08:00:00.000Z",
    };
    const test = setup({ article, events: [started] });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(test.article).toMatchObject({ status: "needs_review", qa_status: "pass" });
    expect(eventsOf(test, "auto_qa_repair_recovery_progress")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(0);
  });

  it("retries safely after a pre-paid Sheets error and records only one paid attempt", async () => {
    const test = setup();
    test.regenerateArticle.mockRejectedValueOnce(new Error("sheets quota before paid ledger"));

    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(eventsOf(test, "regeneration_attempt_started")).toHaveLength(0);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(0);
    expect(test.article).toMatchObject({ qa_status: "fail", manual_required: false });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(2);
    expect(eventsOf(test, "regeneration_attempt_started")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(0);
    expect(test.article).toMatchObject({ status: "needs_review", qa_status: "pass" });
  });

  it("does not replay an ambiguous paid call after its inner ledger exists", async () => {
    const article = repairArticle({ status: "failed_qa", telegram_message_id: 60 });
    const inputHash = articleContentHash(article);
    const started: SheetRecord = {
      __rowNumber: 20,
      event_id: "evt-auto-started-before-crash",
      article_id: article.article_id,
      event_type: "auto_qa_repair_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "openai",
      provider_object_id: "auto-qa-repair:crashed-operation",
      payload_json: JSON.stringify({ input_hash: inputHash, hash: inputHash, attempt: 1 }),
      created_at: "2026-09-07T08:00:00.000Z",
    };
    const paidAttempt: SheetRecord = {
      __rowNumber: 21,
      event_id: "evt-inner-paid-attempt-before-crash",
      article_id: article.article_id,
      event_type: "regeneration_attempt_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: "system:auto-qa-repair:crashed-operation",
      payload_json: JSON.stringify({ base_hash: inputHash }),
      created_at: "2026-09-07T08:00:01.000Z",
    };
    const test = setup({ article, events: [started, paidAttempt] });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(test.article).toMatchObject({ status: "failed_qa", manual_required: true });
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_notified")).toHaveLength(1);
    expect(payload(eventsOf(test, "auto_qa_repair_exhausted")[0]!)).toMatchObject({
      input_hash: inputHash,
      detail: "interrupted_after_attempt_started",
      started_event_id: "evt-auto-started-before-crash",
    });
    expect(test.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("recovers an already-notified false exhaustion on the same message and reaches the final card", async () => {
    const article = repairArticle({
      status: "failed_qa",
      manual_required: true,
      telegram_message_id: 60,
    });
    const inputHash = articleContentHash(article);
    const started: SheetRecord = {
      __rowNumber: 20,
      event_id: "evt-auto-started-quota-recovery",
      article_id: article.article_id,
      event_type: "auto_qa_repair_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "openai",
      provider_object_id: "auto-qa-repair:quota-recovery",
      payload_json: JSON.stringify({
        input_hash: inputHash,
        hash: inputHash,
        attempt: 1,
      }),
      created_at: "2026-09-07T08:00:00.000Z",
    };
    const exhausted: SheetRecord = {
      __rowNumber: 21,
      event_id: "evt-false-exhausted-after-quota",
      article_id: article.article_id,
      event_type: "auto_qa_repair_exhausted",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: "auto-qa-repair:quota-recovery",
      payload_json: JSON.stringify({
        input_hash: inputHash,
        output_hash: inputHash,
        detail: "interrupted_after_attempt_started",
        started_event_id: started.event_id,
        qa_blockers: "article_too_short",
      }),
      created_at: "2026-09-07T08:01:00.000Z",
    };
    const notified: SheetRecord = {
      __rowNumber: 22,
      event_id: "evt-false-exhausted-notified",
      article_id: article.article_id,
      event_type: "auto_qa_repair_notified",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "telegram",
      provider_object_id: "60",
      payload_json: JSON.stringify({ terminal_event_id: exhausted.event_id, message_id: 60 }),
      created_at: "2026-09-07T08:01:01.000Z",
    };
    const test = setup({ article, events: [started, exhausted, notified] });

    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledOnce();
    expect(test.regenerateArticle).toHaveBeenCalledWith(expect.objectContaining({
      recoverSystemManualGate: true,
    }));
    expect(test.manualFlagAtCall).toEqual([true]);
    expect(test.article).toMatchObject({
      status: "needs_review",
      qa_status: "pass",
      manual_required: false,
      telegram_message_id: 60,
    });
    expect(eventsOf(test, "auto_qa_repair_recovery_progress")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(1);
    expect(test.editMessageText).toHaveBeenCalledTimes(1);
    expect(String(test.editMessageText.mock.calls[0]?.[2])).toContain("Ничего делать пока не нужно");

    const notifier = new ReviewNotifier(
      test.store,
      test.bot,
      test.config,
      test.logger,
    );
    await notifier.runOnce();

    expect(test.editMessageText).toHaveBeenCalledTimes(2);
    const finalCard = String(test.editMessageText.mock.calls[1]?.[2]);
    expect(finalCard).toContain("SEO draft");
    expect(finalCard).toContain("Внутренняя проверка пройдена");
    expect(finalCard).not.toContain("article_too_short");
  });

  it("reconciles a failed H2 committed after a false exhaustion without buying another attempt", async () => {
    const article = repairArticle({ status: "failed_qa", manual_required: true, revision_count: 0 });
    const inputHash = articleContentHash(article);
    Object.assign(article, {
      title: "Druga verzija koja i dalje zahteva ručnu proveru",
      body_markdown: "Izmenjen sadržaj drugog pokušaja.".repeat(40),
      qa_status: "fail",
      qa_blockers: "missing_authoritative_source",
      manual_required: true,
      revision_count: 1,
      content_hash: "",
    });
    const outputHash = articleContentHash(article);
    expect(outputHash).not.toBe(inputHash);

    const providerObjectId = "auto-qa-repair:committed-failed-h2";
    const started: SheetRecord = {
      __rowNumber: 20,
      event_id: "evt-auto-started-failed-h2",
      article_id: article.article_id,
      event_type: "auto_qa_repair_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "openai",
      provider_object_id: providerObjectId,
      payload_json: JSON.stringify({ input_hash: inputHash, attempt: 1 }),
      created_at: "2026-09-07T08:00:00.000Z",
    };
    const falseTerminal: SheetRecord = {
      __rowNumber: 21,
      event_id: "evt-false-exhausted-failed-h2",
      article_id: article.article_id,
      event_type: "auto_qa_repair_exhausted",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: providerObjectId,
      payload_json: JSON.stringify({
        input_hash: inputHash,
        output_hash: inputHash,
        detail: "interrupted_after_attempt_started",
        started_event_id: started.event_id,
        qa_blockers: "quality_score_below_threshold",
      }),
      created_at: "2026-09-07T08:00:01.000Z",
    };
    const oldNotification: SheetRecord = {
      __rowNumber: 22,
      event_id: "evt-old-false-exhausted-notification",
      article_id: article.article_id,
      event_type: "auto_qa_repair_notified",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "telegram",
      provider_object_id: "60",
      payload_json: JSON.stringify({ terminal_event_id: falseTerminal.event_id, message_id: 60 }),
      created_at: "2026-09-07T08:00:02.000Z",
    };
    const recoveryProgress: SheetRecord = {
      __rowNumber: 23,
      event_id: "evt-recovery-progress-failed-h2",
      article_id: article.article_id,
      event_type: "auto_qa_repair_recovery_progress",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "telegram",
      provider_object_id: "60",
      payload_json: JSON.stringify({ started_event_id: started.event_id, input_hash: inputHash }),
      created_at: "2026-09-07T08:00:03.000Z",
    };
    const paidAttempt: SheetRecord = {
      __rowNumber: 24,
      event_id: "evt-paid-attempt-failed-h2",
      article_id: article.article_id,
      event_type: "regeneration_attempt_started",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: `system:${providerObjectId}`,
      payload_json: JSON.stringify({ base_hash: inputHash }),
      created_at: "2026-09-07T08:00:04.000Z",
    };
    const regenerated: SheetRecord = {
      __rowNumber: 25,
      event_id: "evt-regenerated-failed-h2",
      article_id: article.article_id,
      event_type: "regenerated",
      actor_type: "system",
      actor_id: "auto-qa-repair",
      provider: "system",
      provider_object_id: `system:${providerObjectId}`,
      payload_json: JSON.stringify({ previous_hash: inputHash, revision_count: 1 }),
      created_at: "2026-09-07T08:00:05.000Z",
    };
    const test = setup({
      article,
      events: [
        started,
        falseTerminal,
        oldNotification,
        recoveryProgress,
        paidAttempt,
        regenerated,
      ],
    });

    await test.service.runOnce();
    await test.service.runOnce();

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    const realTerminals = eventsOf(test, "auto_qa_repair_exhausted").filter((event) =>
      payload(event).detail !== "interrupted_after_attempt_started",
    );
    expect(realTerminals).toHaveLength(1);
    expect(payload(realTerminals[0]!)).toMatchObject({
      input_hash: inputHash,
      output_hash: outputHash,
      outcome: "exhausted",
    });
    expect(eventsOf(test, "auto_qa_repair_notified")).toHaveLength(2);
    expect(test.editMessageText).toHaveBeenCalledTimes(1);
    const warning = String(test.editMessageText.mock.calls[0]?.[2]);
    expect(warning).toContain("Не удалось исправить статью автоматически");
    expect(warning).not.toContain("missing_authoritative_source");
  });

  it("records an exhausted terminal state when generation throws without exposing details", async () => {
    const test = setup({ mode: "throw" });

    await expect(test.service.runOnce()).resolves.toBeUndefined();
    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(test.article).toMatchObject({ status: "failed_qa", manual_required: true });
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_notified")).toHaveLength(1);
    const warning = String(test.editMessageText.mock.calls.at(-1)?.[2]);
    expect(warning).not.toContain("upstream secret detail");
    expect(payload(eventsOf(test, "auto_qa_repair_exhausted")[0]!).detail).toBe(
      "error:upstream secret detail",
    );
  });

  it("marks a raced automatic attempt superseded without exhausting the newer draft", async () => {
    const test = setup({ mode: "stale" });

    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledOnce();
    expect(test.article).toMatchObject({
      status: "failed_qa",
      qa_status: "fail",
      manual_required: false,
      revision_count: 1,
    });
    expect(eventsOf(test, "auto_qa_repair_superseded")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(0);
    expect(eventsOf(test, "auto_qa_repair_notified")).toHaveLength(0);
  });

  it("reconciles a committed passing regeneration after restart before scanning new failures", async () => {
    const article = repairArticle({
      status: "needs_review",
      qa_status: "pass",
      qa_blockers: "",
      manual_required: false,
      revision_count: 1,
      title: "Potpuni vodič posle automatske dorade",
      body_markdown: "Dovoljno dugačak i proveren tekst za roditelje.".repeat(80),
    });
    const inputHash = "a".repeat(64);
    const providerObjectId = "auto-qa-repair:recovered-pass";
    const started: SheetRecord = {
      __rowNumber: 20,
      event_id: "evt-auto-started-pass-crash",
      article_id: article.article_id,
      event_type: "auto_qa_repair_started",
      provider: "openai",
      provider_object_id: providerObjectId,
      payload_json: JSON.stringify({ input_hash: inputHash }),
    };
    const regenerated: SheetRecord = {
      __rowNumber: 21,
      event_id: "evt-regenerated-pass-crash",
      article_id: article.article_id,
      event_type: "regenerated",
      provider: "system",
      provider_object_id: `system:${providerObjectId}`,
      payload_json: JSON.stringify({ revision_count: 1 }),
    };
    const test = setup({ article, events: [started, regenerated] });

    await test.service.runOnce();

    expect(test.regenerateArticle).not.toHaveBeenCalled();
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(1);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(0);
  });

  it("continues the one repair when the progress message cannot be delivered", async () => {
    const editMessageText = vi.fn(async () => {
      throw new Error("telegram unavailable");
    });
    const test = setup({ editMessageText });

    await test.service.runOnce();

    expect(test.regenerateArticle).toHaveBeenCalledTimes(1);
    expect(test.article).toMatchObject({ status: "needs_review", qa_status: "pass" });
    const progress = eventsOf(test, "auto_qa_repair_progress");
    expect(progress).toHaveLength(1);
    expect(payload(progress[0]!)).toMatchObject({ delivered: false, message_id: 60 });
    expect(test.logger.warn).toHaveBeenCalled();
  });

  it("fails closed on a contradictory pass that still requires manual review", async () => {
    const test = setup();
    test.regenerateArticle.mockImplementationOnce(async (request: RegenerationRequest) => {
      Object.assign(test.article, {
        status: "needs_review",
        qa_status: "pass",
        qa_blockers: "",
        manual_required: true,
        title: "Izmenjen naslov sa sticky ručnom proverom",
      });
      test.events.push({
        __rowNumber: 30,
        event_id: "evt-regenerated-sticky",
        article_id: test.article.article_id,
        event_type: "regenerated",
        provider: "system",
        provider_object_id: `system:${request.providerObjectId}`,
        payload_json: "{}",
        created_at: "2026-09-07T08:01:00.000Z",
      } as SheetRecord);
      return { outcome: "regenerated", article: test.article };
    });

    await test.service.runOnce();

    expect(test.article).toMatchObject({
      status: "failed_qa",
      qa_status: "fail",
      manual_required: true,
    });
    expect(eventsOf(test, "auto_qa_repair_completed")).toHaveLength(0);
    expect(eventsOf(test, "auto_qa_repair_exhausted")).toHaveLength(1);
  });
});
