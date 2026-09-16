import { createHash } from "node:crypto";
import { articleContentHash, stringCell } from "./domain/article.js";
import { loadConfig } from "./config.js";
import { OpenAiArticleGenerator } from "./generation/openai-generator.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { createLogger } from "./lib/logger.js";
import { GoogleSheetsStore } from "./sheets/google-sheets.js";
import { GenerationService } from "./services/generation-service.js";
import { QualityGate } from "./services/quality-gate.js";

const articleId = process.argv[2]?.trim();
if (!articleId) throw new Error("Usage: node dist/src/operator-regenerate.js <article-id>");

const config = loadConfig();
if (!config.openAiApiKey) throw new Error("OPENAI_API_KEY is required");

const logger = createLogger(config.logLevel);
const store = new GoogleSheetsStore(config);
const article = await store.findArticle(articleId);
if (!article) throw new Error(`Article not found: ${articleId}`);
const feedback = stringCell(article.feedback);
if (!feedback) throw new Error(`Article ${articleId} has no stored editor feedback`);
const baseContentHash = articleContentHash(article);
const repairKey = createHash("sha256")
  .update(JSON.stringify({ articleId, baseContentHash, feedback, model: config.openAiModel, workflow: 1 }))
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
