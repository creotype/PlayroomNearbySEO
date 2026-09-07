import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostAdminClient } from "../src/ghost/client.js";

afterEach(() => vi.unstubAllGlobals());

describe("GhostAdminClient.uploadImage", () => {
  it("uploads multipart media and returns the durable Ghost URL", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://example.com/internal/ghost/api/admin/images/upload/");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers.Authorization).toMatch(/^Ghost /u);
      const form = init?.body as FormData;
      expect(form.get("purpose")).toBe("image");
      expect(form.get("ref")).toBe("playroom-hero-key");
      const file = form.get("file") as File;
      expect(file.name).toBe("hero.webp");
      expect(file.type).toBe("image/webp");
      expect(await file.text()).toBe("fake-webp");
      return new Response(JSON.stringify({
        images: [{ url: "https://example.com/content/images/hero.webp", ref: "playroom-hero-key" }],
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("fake-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
      ref: "playroom-hero-key",
    })).resolves.toEqual({
      url: "https://example.com/content/images/hero.webp",
      ref: "playroom-hero-key",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an empty upload before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.alloc(0),
      filename: "hero.webp",
      contentType: "image/webp",
    })).rejects.toThrow("empty file");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
