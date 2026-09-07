import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalString = (schema: z.ZodString) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const integerFromEnv = z.coerce.number().int().positive();

const localClockTime = z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/u);
const weekdayListFromEnv = z.string()
  .regex(/^[0-6](?:\s*,\s*[0-6])*$/u)
  .transform((value) => [...new Set(value.split(",").map((day) => Number(day.trim())))].sort());

const landscapeImageSize = z.string().regex(/^\d+x\d+$/u).superRefine((value, context) => {
  const [width, height] = value.split("x").map(Number);
  if (!width || !height) return;
  if (width <= height) {
    context.addIssue({ code: "custom", message: "must be a landscape WIDTHxHEIGHT resolution" });
  }
  if (width > 3_840 || height > 3_840 || width % 16 !== 0 || height % 16 !== 0) {
    context.addIssue({ code: "custom", message: "edges must be multiples of 16 and no larger than 3840" });
  }
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400 || width / height > 3) {
    context.addIssue({ code: "custom", message: "resolution is outside GPT Image 2 aspect/pixel limits" });
  }
});

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
    OPENAI_IMAGE_MODEL: z.string().regex(/^gpt-image-2(?:-\d{4}-\d{2}-\d{2})?$/u).default("gpt-image-2"),
    OPENAI_IMAGE_SIZE: landscapeImageSize.default("1536x1024"),
    OPENAI_IMAGE_QUALITY: z.enum(["low", "medium", "high", "auto"]).default("high"),
    HERO_IMAGE_CACHE_DIR: z.string().min(1).default("data/hero-images"),
    EDITORIAL_AUTOMATION_ENABLED: booleanFromEnv.default(false),
    EDITORIAL_TIME_ZONE: z.string().min(1).refine(isValidIanaTimeZone, "must be a valid IANA timezone").default("Europe/Belgrade"),
    EDITORIAL_RUN_DAYS: weekdayListFromEnv.default(() => [1, 5]),
    EDITORIAL_RUN_TIME: localClockTime.default("10:00"),
    AUTO_PUBLISH_AFTER_REVIEW: booleanFromEnv.default(true),
    REVIEW_DEADLINE_HOURS: integerFromEnv.default(48),
    PUBLICATION_TIME: localClockTime.default("10:00"),
    TARGET_ENVIRONMENT: z.enum(["staging", "production"]).default("staging"),
    PORT: integerFromEnv.default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    POLL_INTERVAL_MS: integerFromEnv.min(5_000).default(15_000),
    DRY_RUN: booleanFromEnv.default(true),
    ALLOW_GHOST_PUBLISH: booleanFromEnv.default(false),
    ALLOW_TELEGRAM_GENERATION: booleanFromEnv.default(false),
  })
  .superRefine((value, context) => {
    if (!value.GOOGLE_APPLICATION_CREDENTIALS && !value.GOOGLE_SERVICE_ACCOUNT_JSON) {
      context.addIssue({
        code: "custom",
        message: "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON",
        path: ["GOOGLE_APPLICATION_CREDENTIALS"],
      });
    }
    if ((value.EDITORIAL_AUTOMATION_ENABLED || value.ALLOW_TELEGRAM_GENERATION) && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: "custom",
        message: "is required when editorial automation or Telegram generation is enabled",
        path: ["OPENAI_API_KEY"],
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
  openAiImageModel: string;
  openAiImageSize: string;
  openAiImageQuality: "low" | "medium" | "high" | "auto";
  heroImageCacheDir: string;
  editorialAutomationEnabled: boolean;
  editorialTimeZone: string;
  editorialRunDays: number[];
  editorialRunTime: string;
  autoPublishAfterReview: boolean;
  reviewDeadlineHours: number;
  publicationTime: string;
  targetEnvironment: "staging" | "production";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  pollIntervalMs: number;
  dryRun: boolean;
  allowGhostPublish: boolean;
  allowTelegramGeneration: boolean;
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
    openAiImageModel: value.OPENAI_IMAGE_MODEL,
    openAiImageSize: value.OPENAI_IMAGE_SIZE,
    openAiImageQuality: value.OPENAI_IMAGE_QUALITY,
    heroImageCacheDir: value.HERO_IMAGE_CACHE_DIR,
    editorialAutomationEnabled: value.EDITORIAL_AUTOMATION_ENABLED,
    editorialTimeZone: value.EDITORIAL_TIME_ZONE,
    editorialRunDays: value.EDITORIAL_RUN_DAYS,
    editorialRunTime: value.EDITORIAL_RUN_TIME,
    autoPublishAfterReview: value.AUTO_PUBLISH_AFTER_REVIEW,
    reviewDeadlineHours: value.REVIEW_DEADLINE_HOURS,
    publicationTime: value.PUBLICATION_TIME,
    targetEnvironment: value.TARGET_ENVIRONMENT,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    pollIntervalMs: value.POLL_INTERVAL_MS,
    dryRun: value.DRY_RUN,
    allowGhostPublish: value.ALLOW_GHOST_PUBLISH,
    allowTelegramGeneration: value.ALLOW_TELEGRAM_GENERATION,
  };
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
