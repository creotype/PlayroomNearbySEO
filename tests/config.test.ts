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
    expect(config.openAiImageModel).toBe("gpt-image-2");
    expect(config.openAiImageSize).toBe("1536x1024");
    expect(config.openAiImageQuality).toBe("high");
    expect(config.heroImageCacheDir).toBe("data/hero-images");
    expect(config.editorialAutomationEnabled).toBe(false);
    expect(config.editorialTimeZone).toBe("Europe/Belgrade");
    expect(config.editorialRunDays).toEqual([1, 5]);
    expect(config.editorialRunTime).toBe("10:00");
    expect(config.autoPublishAfterReview).toBe(true);
    expect(config.reviewDeadlineHours).toBe(48);
    expect(config.publicationTime).toBe("10:00");
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

  it.each([
    { EDITORIAL_AUTOMATION_ENABLED: "true" },
    { ALLOW_TELEGRAM_GENERATION: "true" },
  ])("requires OpenAI credentials when generation is enabled", (featureFlag) => {
    expect(() => loadConfig({ ...validEnv, ...featureFlag })).toThrow("OPENAI_API_KEY");
  });

  it.each(["1024x1024", "1024x1536", "1537x1024", "4096x1024", "3000x512"])(
    "rejects non-landscape or unsupported GPT Image resolution %s",
    (size) => {
      expect(() => loadConfig({ ...validEnv, OPENAI_IMAGE_SIZE: size })).toThrow(
        "OPENAI_IMAGE_SIZE",
      );
    },
  );

  it("validates editorial schedule values", () => {
    expect(() => loadConfig({ ...validEnv, EDITORIAL_RUN_DAYS: "1,7" })).toThrow(
      "EDITORIAL_RUN_DAYS",
    );
    expect(() => loadConfig({ ...validEnv, EDITORIAL_RUN_TIME: "24:00" })).toThrow(
      "EDITORIAL_RUN_TIME",
    );
    expect(() => loadConfig({ ...validEnv, PUBLICATION_TIME: "ten" })).toThrow(
      "PUBLICATION_TIME",
    );
    expect(() => loadConfig({ ...validEnv, EDITORIAL_TIME_ZONE: "Belgrade-ish" })).toThrow(
      "EDITORIAL_TIME_ZONE",
    );
  });

  it("rejects an image model that does not support the configured GPT Image 2 contract", () => {
    expect(() => loadConfig({ ...validEnv, OPENAI_IMAGE_MODEL: "dall-e-3" })).toThrow(
      "OPENAI_IMAGE_MODEL",
    );
  });
});
