import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalString = (schema: z.ZodString) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const integerFromEnv = z.coerce.number().int().positive();

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    GOOGLE_SPREADSHEET_ID: z.string().min(1),
    GOOGLE_APPLICATION_CREDENTIALS: optionalString(z.string().min(1)),
    GOOGLE_SERVICE_ACCOUNT_JSON: optionalString(z.string().min(1)),
    TELEGRAM_BOT_TOKEN: z.string().min(20),
    TELEGRAM_REVIEW_CHAT_ID: optionalString(z.string().regex(/^-?\d+$/)),
    GHOST_ADMIN_URL: z.string().url().default("https://beaver.run.place/internal"),
    GHOST_ADMIN_API_KEY: z.string().regex(/^[a-f0-9]+:[a-f0-9]+$/i),
    GHOST_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v5.0"),
    OPENAI_API_KEY: optionalString(z.string().min(20)),
    OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
    TARGET_ENVIRONMENT: z.enum(["staging", "production"]).default("staging"),
    PORT: integerFromEnv.default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    POLL_INTERVAL_MS: integerFromEnv.min(5_000).default(15_000),
    DRY_RUN: booleanFromEnv.default(true),
    ALLOW_GHOST_PUBLISH: booleanFromEnv.default(false),
  })
  .superRefine((value, context) => {
    if (!value.GOOGLE_APPLICATION_CREDENTIALS && !value.GOOGLE_SERVICE_ACCOUNT_JSON) {
      context.addIssue({
        code: "custom",
        message: "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON",
        path: ["GOOGLE_APPLICATION_CREDENTIALS"],
      });
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  spreadsheetId: string;
  googleApplicationCredentials?: string;
  googleServiceAccountJson?: string;
  telegramBotToken: string;
  telegramReviewChatId?: number;
  ghostAdminUrl: string;
  ghostAdminApiKey: string;
  ghostApiVersion: string;
  openAiApiKey?: string;
  openAiModel: string;
  targetEnvironment: "staging" | "production";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  pollIntervalMs: number;
  dryRun: boolean;
  allowGhostPublish: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${summary}`);
  }

  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    spreadsheetId: value.GOOGLE_SPREADSHEET_ID,
    ...(value.GOOGLE_APPLICATION_CREDENTIALS
      ? { googleApplicationCredentials: value.GOOGLE_APPLICATION_CREDENTIALS }
      : {}),
    ...(value.GOOGLE_SERVICE_ACCOUNT_JSON
      ? { googleServiceAccountJson: value.GOOGLE_SERVICE_ACCOUNT_JSON }
      : {}),
    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    ...(value.TELEGRAM_REVIEW_CHAT_ID
      ? { telegramReviewChatId: Number(value.TELEGRAM_REVIEW_CHAT_ID) }
      : {}),
    ghostAdminUrl: value.GHOST_ADMIN_URL.replace(/\/$/, ""),
    ghostAdminApiKey: value.GHOST_ADMIN_API_KEY,
    ghostApiVersion: value.GHOST_API_VERSION,
    ...(value.OPENAI_API_KEY ? { openAiApiKey: value.OPENAI_API_KEY } : {}),
    openAiModel: value.OPENAI_MODEL,
    targetEnvironment: value.TARGET_ENVIRONMENT,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    pollIntervalMs: value.POLL_INTERVAL_MS,
    dryRun: value.DRY_RUN,
    allowGhostPublish: value.ALLOW_GHOST_PUBLISH,
  };
}
