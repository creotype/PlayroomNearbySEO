import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "telegramBotToken",
        "ghostAdminApiKey",
        "openAiApiKey",
        "googleServiceAccountJson",
        "*.token",
        "*.apiKey",
      ],
      censor: "[REDACTED]",
    },
  });
}
