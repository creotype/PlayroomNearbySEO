import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  GOOGLE_SPREADSHEET_ID: "sheet",
  GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({ client_email: "bot@example.com" })).toString("base64"),
  TELEGRAM_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz",
  GHOST_ADMIN_API_KEY: "abcdef:0123456789abcdef",
};

describe("loadConfig", () => {
  it("defaults to dry-run with publishing disabled", () => {
    const config = loadConfig(validEnv);
    expect(config.dryRun).toBe(true);
    expect(config.allowGhostPublish).toBe(false);
    expect(config.allowTelegramGeneration).toBe(false);
    expect(config.targetEnvironment).toBe("staging");
  });

  it("requires an explicit Google runtime identity", () => {
    const { GOOGLE_SERVICE_ACCOUNT_JSON: _, ...withoutGoogleIdentity } = validEnv;
    expect(() => loadConfig(withoutGoogleIdentity)).toThrow("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("rejects misspelled safety booleans instead of failing open", () => {
    expect(() => loadConfig({ ...validEnv, DRY_RUN: "flase" })).toThrow("DRY_RUN");
    expect(() => loadConfig({ ...validEnv, ALLOW_TELEGRAM_GENERATION: "flase" })).toThrow(
      "ALLOW_TELEGRAM_GENERATION",
    );
  });

  it("treats blank optional values as absent", () => {
    const config = loadConfig({
      ...validEnv,
      TELEGRAM_REVIEW_CHAT_ID: "   ",
      OPENAI_API_KEY: "",
    });
    expect(config.telegramReviewChatId).toBeUndefined();
    expect(config.openAiApiKey).toBeUndefined();
  });
});
