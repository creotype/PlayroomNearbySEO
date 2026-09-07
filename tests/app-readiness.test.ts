import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { runStartupChecks, verifyGhost } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { GhostAdminClient } from "../src/ghost/client.js";
import type { ReadinessState } from "../src/health.js";
import type { GoogleSheetsStore } from "../src/sheets/google-sheets.js";
import type { SeoBot } from "../src/telegram/bot.js";

const config: AppConfig = {
  nodeEnv: "test",
  spreadsheetId: "sheet",
  googleServiceAccountJson: "service-account-json",
  telegramBotToken: "123456789:telegram-token-value",
  ghostAdminUrl: "https://example.com/internal",
  ghostAdminApiKey: "ghost-key-id:ghost-secret-value",
  ghostApiVersion: "v5.0",
  openAiApiKey: "sk-test-openai-secret",
  openAiModel: "gpt-5-mini",
  openAiImageModel: "gpt-image-2",
  openAiImageSize: "1536x1024",
  openAiImageQuality: "high",
  heroImageCacheDir: "data/hero-images",
  editorialAutomationEnabled: false,
  editorialTimeZone: "Europe/Belgrade",
  editorialRunDays: [1, 5],
  editorialRunTime: "10:00",
  autoPublishAfterReview: true,
  reviewDeadlineHours: 48,
  publicationTime: "10:00",
  targetEnvironment: "staging",
  port: 8080,
  logLevel: "silent",
  pollIntervalMs: 15_000,
  dryRun: true,
  allowGhostPublish: false,
  allowTelegramGeneration: false,
};

function ghostClient(overrides: {
  readSite?: () => Promise<{ title: string; url: string; version: string }>;
  readCurrentUser?: () => Promise<{ id: string; name: string; status: string } | undefined>;
} = {}): GhostAdminClient {
  return {
    readSite: overrides.readSite ??
      vi.fn(async () => ({ title: "Site", url: "https://example.com", version: "5.0" })),
    readCurrentUser: overrides.readCurrentUser ??
      vi.fn(async () => ({ id: "user-1", name: "Editor", status: "active" })),
  } as unknown as GhostAdminClient;
}

describe("startup Ghost readiness", () => {
  it("requires both the site probe and an active authenticated user", async () => {
    const readSite = vi.fn(async () => ({
      title: "Site",
      url: "https://example.com",
      version: "5.0",
    }));
    const readCurrentUser = vi.fn(async () => ({
      id: "user-1",
      name: "Editor",
      status: " ACTIVE ",
    }));

    await expect(verifyGhost(ghostClient({ readSite, readCurrentUser }))).resolves.toBeUndefined();
    expect(readSite).toHaveBeenCalledOnce();
    expect(readCurrentUser).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing", user: undefined, message: "was not returned" },
    {
      name: "inactive",
      user: { id: "user-1", name: "Editor", status: "inactive" },
      message: "is not active",
    },
  ])("rejects a $name current user", async ({ user, message }) => {
    const ghost = ghostClient({ readCurrentUser: vi.fn(async () => user) });
    await expect(verifyGhost(ghost)).rejects.toThrow(message);
  });

  it("fails startup on Ghost authentication errors without exposing credentials", async () => {
    const readiness: ReadinessState = { ready: false, checks: {} };
    const authError = `Ghost API 401 for ${config.ghostAdminApiKey}`;
    const ghost = ghostClient({
      readCurrentUser: vi.fn(async () => {
        throw new Error(authError);
      }),
    });
    const store = {
      verifySchema: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => new Map([["timezone", "Europe/Belgrade"]])),
    } as unknown as GoogleSheetsStore;
    const bot = {
      api: {
        getMe: vi.fn(async () => ({ id: 1, is_bot: true, first_name: "Bot", username: "bot" })),
        setMyCommands: vi.fn(async () => true),
      },
    } as unknown as SeoBot;
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;

    await expect(
      runStartupChecks({ readiness, store, ghost, bot, logger, config }),
    ).rejects.toThrow("Service is not ready");

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.ghost).toEqual({
      ok: false,
      detail: "Ghost API 401 for [REDACTED]",
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(config.ghostAdminApiKey);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("ghost-secret-value");
  });

  it("fails startup when the Sheet timezone is not a valid IANA zone", async () => {
    const readiness: ReadinessState = { ready: false, checks: {} };
    const store = {
      verifySchema: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => new Map([["timezone", "Belgrade-ish"]])),
    } as unknown as GoogleSheetsStore;
    const bot = {
      api: {
        getMe: vi.fn(async () => ({ id: 1, is_bot: true, first_name: "Bot", username: "bot" })),
        setMyCommands: vi.fn(async () => true),
      },
    } as unknown as SeoBot;
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;

    await expect(
      runStartupChecks({ readiness, store, ghost: ghostClient(), bot, logger, config }),
    ).rejects.toThrow("Service is not ready");

    expect(readiness.checks.google_sheets?.ok).toBe(false);
    expect(readiness.checks.google_sheets?.detail).toContain("valid IANA timezone");
  });
});
