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

  it("retries an api_keys ECONNRESET response with a fresh multipart body", async () => {
    const bodies: FormData[] = [];
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as FormData);
      signals.push(init?.signal as AbortSignal);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          errors: [{
            message: "An unexpected error occurred, please try again.",
            context: "select `api_keys`.* from `api_keys` where `api_keys`.`id` = 'key' limit 1 - read ECONNRESET",
          }],
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({
        images: [{ url: "https://example.com/content/images/retried.webp" }],
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("cached-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
      ref: "playroom-hero-key",
    })).resolves.toEqual({ url: "https://example.com/content/images/retried.webp" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(signals[0]).not.toBe(signals[1]);
    const firstFile = bodies[0]?.get("file") as File;
    const secondFile = bodies[1]?.get("file") as File;
    expect(firstFile).not.toBe(secondFile);
    expect(await firstFile.text()).toBe("cached-webp");
    expect(await secondFile.text()).toBe("cached-webp");
    expect(bodies.map((body) => body.get("purpose"))).toEqual(["image", "image"]);
    expect(bodies.map((body) => body.get("ref"))).toEqual([
      "playroom-hero-key",
      "playroom-hero-key",
    ]);
  });

  it("stops after three provably pre-upload failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [{
        message: "An unexpected error occurred, please try again.",
        context: "select `api_keys`.* from `api_keys` - read ECONNRESET",
      }],
    }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "0" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("cached-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
    })).rejects.toThrow("Ghost API 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [500, "database temporarily unavailable"],
    [429, "rate limit exceeded"],
    [400, "select `api_keys`.* from `api_keys` - read ECONNRESET"],
  ])("does not retry an unsafe HTTP %i response", async (status, context) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [{ message: "request failed", context }],
    }), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("cached-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
    })).rejects.toThrow(`Ghost API ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not combine retry markers from separate Ghost errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [
        { message: "select `api_keys`.* from `api_keys` failed" },
        { context: "read ECONNRESET" },
      ],
    }), { status: 500, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("cached-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
    })).rejects.toThrow("Ghost API 500");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous network error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed after the request may have been sent");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.uploadImage({
      bytes: Buffer.from("cached-webp"),
      filename: "hero.webp",
      contentType: "image/webp",
    })).rejects.toThrow("request may have been sent");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("GhostAdminClient write retry isolation", () => {
  it("does not retry post creation even for the safe image-upload signature", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [{
        message: "An unexpected error occurred, please try again.",
        context: "select `api_keys`.* from `api_keys` - read ECONNRESET",
      }],
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Retry-After": "0" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(client.createPost({
      title: "Title",
      slug: "title",
      html: "<p>Body</p>",
      status: "draft",
      tags: [],
    })).rejects.toThrow("Ghost API 500");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
