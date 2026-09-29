import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeneratedArticle } from "../src/generation/openai-generator.js";
import {
  InitialGenerationCheckpointStore,
  type InitialGenerationCheckpoint,
} from "../src/services/initial-generation-checkpoint-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<{
  parent: string;
  root: string;
  store: InitialGenerationCheckpointStore;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "playroom-generation-checkpoint-test-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "nested", "checkpoints");
  return { parent, root, store: new InitialGenerationCheckpointStore(root) };
}

function generated(overrides: Partial<GeneratedArticle> = {}): GeneratedArticle {
  return {
    title: "Kako izabrati aktivnosti za decu u Beogradu",
    slug: "kako-izabrati-aktivnosti-za-decu-u-beogradu",
    excerpt: "Praktičan vodič za roditelje koji traže aktivnosti za decu u Beogradu.",
    seo_title: "Aktivnosti za decu u Beogradu: vodič",
    meta_description:
      "Praktičan vodič za roditelje koji biraju aktivnosti za decu u Beogradu prema uzrastu, lokaciji i interesovanjima.",
    body_markdown: `${"Praktičan savet za roditelje. ".repeat(120)}\n\n[Playroom Nearby](https://playroom-kids.rs/rs)`,
    tags: ["roditelji", "Beograd"],
    source_urls: ["https://example.com/source"],
    internal_links: ["https://playroom-kids.rs/rs"],
    quality_score: 9,
    qa_blockers: [],
    ...overrides,
  };
}

function checkpoint(overrides: Partial<InitialGenerationCheckpoint> = {}): InitialGenerationCheckpoint {
  return {
    version: 1,
    articleId: "SEO-TG-CHECKPOINT-001",
    keywordId: "KW-CHECKPOINT-001",
    requestKey: "telegram:message:-5484259760:1000",
    model: "gpt-5-mini",
    generated: generated(),
    createdAt: "2026-09-29T12:34:56.000Z",
    ...overrides,
  };
}

describe("InitialGenerationCheckpointStore", () => {
  it("atomically creates its directory and round-trips a validated checkpoint", async () => {
    const { root, store } = await temporaryStore();
    const original = checkpoint();

    await expect(store.save(original)).resolves.toEqual(original);
    await expect(store.load(original.articleId)).resolves.toEqual(original);

    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);

    if (process.platform !== "win32") {
      const metadata = await stat(path.join(root, files[0]!));
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  it("uses an opaque filename even when the article ID contains path syntax", async () => {
    const { parent, root, store } = await temporaryStore();
    const unsafeLookingId = "../../outside\\article:001";
    await store.save(checkpoint({ articleId: unsafeLookingId }));

    const files = await readdir(root);
    expect(files).toEqual([
      `${createHash("sha256").update(unsafeLookingId).digest("hex")}.json`,
    ]);
    expect(await readdir(parent)).toEqual(["nested"]);
    await expect(store.load(unsafeLookingId)).resolves.toMatchObject({ articleId: unsafeLookingId });
  });

  it("is idempotent for the same checkpoint and refuses to overwrite a paid result", async () => {
    const { root, store } = await temporaryStore();
    const original = checkpoint();
    await store.save(original);

    await expect(store.save(original)).resolves.toEqual(original);
    await expect(store.save(checkpoint({ model: "different-model" }))).rejects.toThrow(
      "already exists",
    );
    expect(await readdir(root)).toHaveLength(1);
    await expect(store.load(original.articleId)).resolves.toEqual(original);
  });

  it("rejects invalid checkpoints before writing anything", async () => {
    const { root, store } = await temporaryStore();
    const invalid = checkpoint({ createdAt: "not-a-date" });

    await expect(store.save(invalid)).rejects.toThrow();
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for malformed or mismatched checkpoint files", async () => {
    const { root, store } = await temporaryStore();
    const original = checkpoint();
    await store.save(original);
    const [filename] = await readdir(root);
    const checkpointPath = path.join(root, filename!);

    await writeFile(checkpointPath, "{broken", "utf8");
    await expect(store.load(original.articleId)).rejects.toThrow("not valid JSON");

    await writeFile(
      checkpointPath,
      `${JSON.stringify(checkpoint({ articleId: "SEO-OTHER" }))}\n`,
      "utf8",
    );
    await expect(store.load(original.articleId)).rejects.toThrow("article ID does not match");
  });

  it("removes a checkpoint idempotently", async () => {
    const { root, store } = await temporaryStore();
    const original = checkpoint();
    await store.save(original);

    await store.remove(original.articleId);
    await store.remove(original.articleId);

    await expect(store.load(original.articleId)).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("does not expose generated article contents in validation errors", async () => {
    const { root, store } = await temporaryStore();
    const original = checkpoint();
    await store.save(original);
    const [filename] = await readdir(root);
    const checkpointPath = path.join(root, filename!);
    const raw = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
    raw.generated = { body_markdown: "PRIVATE ARTICLE BODY" };
    await writeFile(checkpointPath, JSON.stringify(raw), "utf8");

    await expect(store.load(original.articleId)).rejects.not.toThrow("PRIVATE ARTICLE BODY");
  });
});
