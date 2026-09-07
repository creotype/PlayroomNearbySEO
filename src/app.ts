import type { Server } from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { isValidIanaTimeZone } from "./config.js";
import { stringCell } from "./domain/article.js";
import { OpenAiHeroImageGenerator } from "./generation/openai-hero-image.js";
import { OpenAiArticleGenerator } from "./generation/openai-generator.js";
import { GhostAdminClient } from "./ghost/client.js";
import { startHealthServer, type ReadinessState } from "./health.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { GoogleSheetsStore } from "./sheets/google-sheets.js";
import { ApprovalService } from "./services/approval-service.js";
import { EditorialAutomationService } from "./services/editorial-automation-service.js";
import { GenerationService } from "./services/generation-service.js";
import { HeroImageService } from "./services/hero-image-service.js";
import { PublicationService } from "./services/publication-service.js";
import { QualityGate } from "./services/quality-gate.js";
import { ReviewNotifier } from "./services/review-notifier.js";
import { Scheduler } from "./services/scheduler.js";
import { createTelegramBot, telegramCommandMenu, waitForTelegramIdle, type SeoBot } from "./telegram/bot.js";

export type RunningApp = {
  shutdown: (signal?: string) => Promise<void>;
  /** Resolves only when a long-running subsystem has stopped unexpectedly. */
  terminalFailure: Promise<Error>;
};

export async function startApp(config: AppConfig, logger: Logger): Promise<RunningApp> {
  const readiness: ReadinessState = { ready: false, checks: {} };
  let reportTerminalFailure!: (error: Error) => void;
  const terminalFailure = new Promise<Error>((resolve) => {
    reportTerminalFailure = resolve;
  });
  const store = new GoogleSheetsStore(config);
  const ghost = new GhostAdminClient({
    url: config.ghostAdminUrl,
    apiKey: config.ghostAdminApiKey,
    apiVersion: config.ghostApiVersion,
  });
  const workflowMutex = new KeyedMutex();
  const qualityGate = new QualityGate(store, config);
  const approvals = new ApprovalService(store, qualityGate, workflowMutex, {
    timeZone: config.editorialTimeZone ?? "Europe/Belgrade",
    publicationTime: config.publicationTime ?? "10:00",
  });
  const generator = config.openAiApiKey
    ? new OpenAiArticleGenerator(config.openAiApiKey, config.openAiModel)
    : undefined;
  const heroImages = config.openAiApiKey
    ? new HeroImageService(
        new OpenAiHeroImageGenerator(
          config.openAiApiKey,
          config.openAiImageModel,
          config.openAiImageSize,
          config.openAiImageQuality,
        ),
        ghost,
        config.heroImageCacheDir,
        logger,
        `${config.targetEnvironment}:${config.ghostAdminUrl}`,
      )
    : undefined;
  const generation = new GenerationService(
    store,
    generator,
    config,
    logger,
    qualityGate,
    workflowMutex,
    heroImages,
  );
  const bot = createTelegramBot({ config, store, approvals, generation, logger });
  const publication = new PublicationService(store, ghost, config, logger, workflowMutex);
  const notifier = new ReviewNotifier(store, bot, config, logger);
  const editorial = new EditorialAutomationService(
    store,
    generation,
    qualityGate,
    bot,
    config,
    logger,
    workflowMutex,
  );
  const scheduler = new Scheduler(config.pollIntervalMs, logger);
  scheduler.add("manual-generator", () => generation.runManualOnce());
  if (config.editorialAutomationEnabled) {
    scheduler.add("editorial-automation", () => editorial.runOnce());
  } else {
    scheduler.add("scheduled-generator", () => generation.runOnce());
  }
  scheduler.add("publisher", () => publication.runOnce());
  scheduler.add("review-notifier", () => notifier.runOnce());

  const healthServer = startHealthServer(config.port, () => readiness, logger);
  await runStartupChecks({ readiness, store, ghost, bot, logger, config });
  scheduler.start();
  const polling = bot
    .start({
      drop_pending_updates: false,
      onStart: (info) => logger.info({ bot: info.username }, "Telegram long polling started"),
    })
    .catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      readiness.ready = false;
      readiness.checks.telegram = {
        ok: false,
        detail: failure.message,
      };
      logger.fatal({ err: readiness.checks.telegram.detail }, "Telegram long polling stopped");
      reportTerminalFailure(failure);
    });

  let stopping = false;
  return {
    terminalFailure,
    shutdown: async (signal = "shutdown") => {
      if (stopping) return;
      stopping = true;
      readiness.ready = false;
      const schedulerDrain = scheduler.stop();
      let stopPolling = Promise.resolve();
      try {
        stopPolling = bot.stop().catch((error: unknown) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Telegram polling stop failed; shutdown drain continues",
          );
        });
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Telegram polling was not fully started; shutdown drain continues",
        );
      }
      await Promise.allSettled([schedulerDrain, stopPolling, polling]);
      await waitForTelegramIdle(bot);
      await closeServer(healthServer);
      logger.info({ signal }, "Service stopped");
    },
  };
}

export async function runStartupChecks(options: {
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
    verifyGhost(ghost),
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
        detail: startupErrorDetail(result.reason, config),
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

export async function verifyGhost(ghost: GhostAdminClient): Promise<void> {
  const [, currentUser] = await Promise.all([ghost.readSite(), ghost.readCurrentUser()]);
  if (!currentUser) throw new Error("Ghost current user was not returned");
  if (currentUser.status.trim().toLowerCase() !== "active") {
    throw new Error("Ghost current user is not active");
  }
}

async function verifySheets(store: GoogleSheetsStore, config: AppConfig): Promise<void> {
  await store.verifySchema();
  const settings = await store.getSettings();
  const timeZone = stringCell(settings.get("timezone")) || config.editorialTimeZone || "Europe/Belgrade";
  if (!isValidIanaTimeZone(timeZone)) throw new Error(`settings.timezone is not a valid IANA timezone: ${timeZone}`);
  if (!config.allowTelegramGeneration) return;
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

function startupErrorDetail(error: unknown, config: AppConfig): string {
  let detail = error instanceof Error ? error.message : String(error);
  const [ghostKeyId, ghostSecret] = config.ghostAdminApiKey.split(":");
  const secrets = [
    config.ghostAdminApiKey,
    ghostKeyId,
    ghostSecret,
    config.telegramBotToken,
    config.openAiApiKey,
    config.googleServiceAccountJson,
  ];
  for (const secret of secrets) {
    if (secret && secret.length >= 6) detail = detail.replaceAll(secret, "[REDACTED]");
  }
  return detail.slice(0, 500);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
