import { SignJWT } from "jose";

export type GhostPost = {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "scheduled" | "published" | "sent";
  url: string;
  updated_at: string;
  published_at?: string | null;
};

export type GhostUser = {
  id: string;
  name: string;
  status: string;
  roles?: Array<{ name: string }>;
};

export type GhostImage = {
  url: string;
  ref?: string;
};

export type GhostPostInput = {
  title: string;
  slug: string;
  html: string;
  status: "draft" | "scheduled" | "published";
  tags: Array<{ name: string }>;
  custom_excerpt?: string;
  meta_title?: string;
  meta_description?: string;
  feature_image?: string;
  feature_image_alt?: string;
  published_at?: string;
  authors?: Array<{ id: string }>;
};

type GhostEnvelope = {
  posts?: GhostPost[];
  users?: GhostUser[];
  images?: GhostImage[];
  errors?: Array<{ message?: string; type?: string; context?: string }>;
};

export class GhostAdminClient {
  readonly #baseUrl: string;
  readonly #keyId: string;
  readonly #secret: Uint8Array;
  readonly #apiVersion: string;

  constructor(options: { url: string; apiKey: string; apiVersion: string }) {
    const [keyId, secretHex, ...rest] = options.apiKey.split(":");
    if (!keyId || !secretHex || rest.length > 0) throw new Error("Invalid Ghost Admin API key");
    this.#baseUrl = `${options.url.replace(/\/$/, "")}/ghost/api/admin`;
    this.#keyId = keyId;
    this.#secret = Uint8Array.from(Buffer.from(secretHex, "hex"));
    this.#apiVersion = options.apiVersion;
  }

  async readSite(): Promise<{ title: string; url: string; version: string }> {
    const response = await this.#request<{ site: { title: string; url: string; version: string } }>(
      "site/",
    );
    return response.site;
  }

  async readCurrentUser(): Promise<GhostUser | undefined> {
    const response = await this.#request<GhostEnvelope>(
      "users/me/?include=roles",
      undefined,
      [404],
    );
    return response.users?.[0];
  }

  async findPostBySlug(slug: string): Promise<GhostPost | undefined> {
    const response = await this.#request<GhostEnvelope>(
      `posts/slug/${encodeURIComponent(slug)}/?formats=html,lexical`,
      undefined,
      [404],
    );
    return response.posts?.[0];
  }

  async readPost(id: string): Promise<GhostPost | undefined> {
    const response = await this.#request<GhostEnvelope>(
      `posts/${encodeURIComponent(id)}/?formats=html,lexical`,
      undefined,
      [404],
    );
    return response.posts?.[0];
  }

  async createPost(input: GhostPostInput): Promise<GhostPost> {
    const response = await this.#request<GhostEnvelope>("posts/?source=html", {
      method: "POST",
      body: JSON.stringify({ posts: [input] }),
    });
    const post = response.posts?.[0];
    if (!post) throw new Error("Ghost create response contained no post");
    return post;
  }

  async uploadImage(input: {
    bytes: Uint8Array;
    filename: string;
    contentType: string;
    ref?: string;
  }): Promise<GhostImage> {
    if (input.bytes.byteLength === 0) throw new Error("Ghost image upload received an empty file");
    if (input.bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("Ghost image upload exceeds the 20 MB application limit");
    }
    const body = new FormData();
    body.append("file", new Blob([input.bytes], { type: input.contentType }), input.filename);
    body.append("purpose", "image");
    if (input.ref) body.append("ref", input.ref);
    const response = await this.#request<GhostEnvelope>("images/upload/", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const image = response.images?.[0];
    if (!image?.url) throw new Error("Ghost image upload response contained no URL");
    return image;
  }

  async updatePost(
    id: string,
    input: GhostPostInput & { updated_at: string },
  ): Promise<GhostPost> {
    const response = await this.#request<GhostEnvelope>(
      `posts/${encodeURIComponent(id)}/?source=html`,
      { method: "PUT", body: JSON.stringify({ posts: [input] }) },
    );
    const post = response.posts?.[0];
    if (!post) throw new Error("Ghost update response contained no post");
    return post;
  }

  async #request<T>(
    path: string,
    init?: RequestInit,
    allowedStatuses: number[] = [],
  ): Promise<T> {
    const token = await this.#createToken();
    const isMultipart = typeof FormData !== "undefined" && init?.body instanceof FormData;
    const response = await fetch(`${this.#baseUrl}/${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Accept-Version": this.#apiVersion,
        Authorization: `Ghost ${token}`,
        ...(init?.body && !isMultipart ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (allowedStatuses.includes(response.status)) return {} as T;
    const raw = await response.text();
    let parsed: GhostEnvelope | undefined;
    try {
      parsed = JSON.parse(raw) as GhostEnvelope;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const reason = parsed?.errors
        ?.map((error) => [error.message, error.context].filter(Boolean).join(" — "))
        .filter(Boolean)
        .join("; ");
      throw new Error(`Ghost API ${response.status}: ${reason || "request failed"}`);
    }
    return (parsed ?? JSON.parse(raw)) as T;
  }

  async #createToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: this.#keyId })
      .setIssuedAt(now)
      .setExpirationTime(now + 5 * 60)
      .setAudience("/admin/")
      .sign(this.#secret);
  }
}
