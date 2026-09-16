import { createHash } from "node:crypto";
import { articleContentHash, booleanCell, stringCell, type SheetRecord } from "./domain/article.js";
import { loadConfig } from "./config.js";
import { OpenAiArticleGenerator } from "./generation/openai-generator.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { createLogger } from "./lib/logger.js";
import { GoogleSheetsStore } from "./sheets/google-sheets.js";
import { GenerationService } from "./services/generation-service.js";
import { QualityGate } from "./services/quality-gate.js";

const articleId = process.argv[2]?.trim();
const recoverSystemGate = process.argv.slice(3).includes("--recover-system-gate");
if (!articleId) {
  throw new Error(
    "Usage: node dist/src/operator-regenerate.js <article-id> [--recover-system-gate]",
  );
}

const config = loadConfig();
if (!config.openAiApiKey) throw new Error("OPENAI_API_KEY is required");

const logger = createLogger(config.logLevel);
const store = new GoogleSheetsStore(config);
const article = await store.findArticle(articleId);
if (!article) throw new Error(`Article not found: ${articleId}`);
const feedback = stringCell(article.feedback);
if (!feedback) throw new Error(`Article ${articleId} has no stored editor feedback`);
const baseContentHash = articleContentHash(article);
if (recoverSystemGate) {
  const events = await store.listEvents(articleId);
  if (!hasRecoverableSystemGate(article, events, baseContentHash)) {
    throw new Error(`Article ${articleId} has no matching system-created exhausted QA gate`);
  }
}
const repairKey = createHash("sha256")
  .update(JSON.stringify({
    articleId,
    baseContentHash,
    feedback,
    model: config.openAiModel,
    recoverSystemGate,
    workflow: 2,
  }))
  .digest("hex")
  .slice(0, 24);

const qualityGate = new QualityGate(store, config);
const generation = new GenerationService(
  store,
  new OpenAiArticleGenerator(config.openAiApiKey, config.openAiModel),
  config,
  logger,
  qualityGate,
  new KeyedMutex(),
);
const result = await generation.regenerateArticle({
  articleId,
  feedback,
  actorId: "operator-repair",
  actorName: "Operator repair",
  providerObjectId: `operator-repair:${repairKey}`,
  actorType: "system",
  provider: "system",
  expectedContentHash: baseContentHash,
  ...(recoverSystemGate ? { recoverSystemManualGate: true } : {}),
});

if (result.outcome === "blocked") {
  console.error(JSON.stringify({ outcome: result.outcome, reason: result.reason, articleId }));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({
    outcome: result.outcome,
    articleId: result.article.article_id,
    status: result.article.status,
    qaStatus: stringCell(result.article.qa_status),
    qaBlockers: stringCell(result.article.qa_blockers),
    revisionCount: result.article.revision_count,
  }));
}

function hasRecoverableSystemGate(
  article: SheetRecord,
  events: SheetRecord[],
  contentHash: string,
): boolean {
  if (
    !booleanCell(article.manual_required) ||
    stringCell(article.status) !== "failed_qa" ||
    stringCell(article.qa_status) !== "fail"
  ) {
    return false;
  }
  const terminalIndex = events.findLastIndex((event) => {
    if (stringCell(event.event_type) !== "auto_qa_repair_exhausted") return false;
    try {
      const payload = JSON.parse(stringCell(event.payload_json)) as Record<string, unknown>;
      return payload.output_hash === contentHash &&
        payload.qa_blockers === stringCell(article.qa_blockers);
    } catch {
      return false;
    }
  });
  if (terminalIndex < 0) return false;
  return events.slice(terminalIndex + 1).every((event) =>
    stringCell(event.actor_type) === "system" &&
    stringCell(event.event_type) === "auto_qa_repair_notified"
  );
}
