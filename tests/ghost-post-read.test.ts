import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostAdminClient } from "../src/ghost/client.js";

afterEach(() => vi.unstubAllGlobals());

describe("GhostAdminClient post reads", () => {
  it.each([
    {
      name: "id",
      invoke: (client: GhostAdminClient) => client.readPost("post/id"),
      pathname: "/internal/ghost/api/admin/posts/post%2Fid/",
    },
    {
      name: "slug",
      invoke: (client: GhostAdminClient) => client.findPostBySlug("article/slug"),
      pathname: "/internal/ghost/api/admin/posts/slug/article%2Fslug/",
    },
  ])("reads a post by $name without requesting rendered content", async ({ invoke, pathname }) => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(pathname);
      expect(url.searchParams.get("fields")).toBe(
        "id,title,slug,status,url,updated_at,published_at",
      );
      expect(url.searchParams.has("formats")).toBe(false);
      return new Response(JSON.stringify({
        posts: [{
          id: "post-1",
          title: "Article",
          slug: "article",
          status: "draft",
          url: "https://example.com/article/",
          updated_at: "2026-09-16T13:00:00.000Z",
          published_at: null,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GhostAdminClient({
      url: "https://example.com/internal",
      apiKey: "abcdef:0123456789abcdef0123456789abcdef",
      apiVersion: "v5.0",
    });

    await expect(invoke(client)).resolves.toMatchObject({ id: "post-1", status: "draft" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a transient server failure for a safe metadata read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: "Internal server error, cannot read post." }],
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(postResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().readPost("post-1")).resolves.toMatchObject({ id: "post-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient network failure for a safe metadata read", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(postResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().readPost("post-1")).resolves.toMatchObject({ id: "post-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a mutating post creation request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [{ message: "Internal server error, cannot add post." }],
    }), { status: 500, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createPost({
      title: "Article",
      slug: "article",
      html: "<p>Body</p>",
      status: "draft",
      tags: [],
    })).rejects.toThrow("Ghost API 500: Internal server error, cannot add post.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function client(): GhostAdminClient {
  return new GhostAdminClient({
    url: "https://example.com/internal",
    apiKey: "abcdef:0123456789abcdef0123456789abcdef",
    apiVersion: "v5.0",
  });
}

function postResponse(): Response {
  return new Response(JSON.stringify({
    posts: [{
      id: "post-1",
      title: "Article",
      slug: "article",
      status: "draft",
      url: "https://example.com/article/",
      updated_at: "2026-09-16T13:00:00.000Z",
      published_at: null,
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
