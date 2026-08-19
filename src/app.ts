import type { Server } from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { OpenAiArticleGenerator } from "./generation/openai-generator.js";
import { GhostAdminClient } from "./ghost/client.js";
import { startHealthServer, type ReadinessState } from "./health.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { GoogleSheetsStore } from "./sheets/google-sheets.js";
import { ApprovalService } from "./services/approval-service.js";
import { GenerationService } from "./services/generation-service.js";
import { PublicationService } from "./services/publication-service.js";
import { QualityGate } from "./services/quality-gate.js";
import { ReviewNotifier } from "./services/review-notifier.js";
import { Scheduler } from "./services/scheduler.js";
import { createTelegramBot, telegramCommandMenu, type SeoBot } from "./telegram/bot.js";

export type RunningApp = {
  shutdown: (signal?: string) => Promise<void>;
};

export async function startApp(config: AppConfig, logger: Logger): Promise<RunningApp> {
  const readiness: ReadinessState = { ready: false, checks: {} };
  const store = new GoogleSheetsStore(config);
  const ghost = new GhostAdminClient({
    url: config.ghostAdminUrl,
    apiKey: config.ghostAdminApiKey,
    apiVersion: config.ghostApiVersion,
  });
  const workflowMutex = new KeyedMutex();
  const qualityGate = new QualityGate(store, config);
  const approvals = new ApprovalService(store, qualityGate, workflowMutex);
  const generator = config.openAiApiKey
    ? new OpenAiArticleGenerator(config.openAiApiKey, config.openAiModel)
    : undefined;
  const generation = new GenerationService(store, generator, config, logger);
  const bot = createTelegramBot({ config, store, approvals, generation, logger });
  const publication = new PublicationService(store, ghost, config, logger, workflowMutex);
  const notifier = new ReviewNotifier(store, bot, config, logger);
  const scheduler = new Scheduler(config.pollIntervalMs, logger);
  scheduler.add("manual-generator", () => generation.runManualOnce());
  scheduler.add("scheduled-generator", () => generation.runOnce());
  scheduler.add("review-notifier", () => notifier.runOnce());
  scheduler.add("publisher", () => publication.runOnce());

  const healthServer = startHealthServer(config.port, () => readiness, logger);
  await runStartupChecks({ readiness, store, ghost, bot, logger, config });
  scheduler.start();
  void bot
    .start({
      drop_pending_updates: false,
      onStart: (info) => logger.info({ bot: info.username }, "Telegram long polling started"),
    })
    .catch((error: unknown) => {
      readiness.ready = false;
      readiness.checks.telegram = {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
      logger.fatal({ err: readiness.checks.telegram.detail }, "Telegram long polling stopped");
    });

  let stopping = false;
  return {
    shutdown: async (signal = "shutdown") => {
      if (stopping) return;
      stopping = true;
      readiness.ready = false;
      scheduler.stop();
      try {
        await bot.stop();
      } catch {
        // grammY throws if polling has not fully started; shutdown can continue.
      }
      await closeServer(healthServer);
      logger.info({ signal }, "Service stopped");
    },
  };
}

async function runStartupChecks(options: {
  readiness: ReadinessState;
  store: GoogleSheetsStore;
  ghost: GhostAdminClient;
  bot: SeoBot;
  logger: Logger;
  config: AppConfig;
}): Promise<void> {
  const { readiness, store, ghost, bot, logger, config } = options;
  const checks = await Promise.allSettled([
    verifySheets(store, config),
    ghost.readSite(),
    verifyTelegram(bot, logger),
  ]);
  const names = ["google_sheets", "ghost", "telegram"] as const;
  checks.forEach((result, index) => {
    const name = names[index]!;
    if (result.status === "fulfilled") {
      readiness.checks[name] = { ok: true };
    } else {
      readiness.checks[name] = {
        ok: false,
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    }
  });
  readiness.ready = Object.values(readiness.checks).every((check) => check.ok);
  if (!readiness.ready) {
    logger.error({ checks: readiness.checks }, "Startup checks failed");
    throw new Error("Service is not ready; inspect startup checks");
  }
  logger.info(
    { dryRun: config.dryRun, ghostPublishingAllowed: config.allowGhostPublish, generatorConfigured: Boolean(config.openAiApiKey) },
    "Startup checks passed",
  );
}

async function verifySheets(store: GoogleSheetsStore, config: AppConfig): Promise<void> {
  await store.verifySchema();
  if (!config.allowTelegramGeneration) return;
  const settings = await store.getSettings();
  if (!settings.has("telegram_generation_enabled")) {
    throw new Error("settings.telegram_generation_enabled is required when Telegram generation is enabled");
  }
}

async function verifyTelegram(bot: SeoBot, logger: Logger): Promise<void> {
  await bot.api.getMe();
  try {
    await bot.api.setMyCommands([...telegramCommandMenu]);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Telegram command menu update failed; command handlers remain available",
    );
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
