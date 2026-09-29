import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  generatedArticleSchema,
  type GeneratedArticle,
} from "../generation/openai-generator.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";

const CHECKPOINT_VERSION = 1 as const;

const boundedIdentifier = z.string().trim().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "must not contain control characters",
);

export const initialGenerationCheckpointSchema = z.object({
  version: z.literal(CHECKPOINT_VERSION),
  articleId: boundedIdentifier,
  keywordId: boundedIdentifier,
  requestKey: z.string().trim().min(1).max(1_024).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  ),
  model: z.string().trim().min(1).max(256).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  ),
  generated: generatedArticleSchema,
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type InitialGenerationCheckpoint = {
  version: typeof CHECKPOINT_VERSION;
  articleId: string;
  keywordId: string;
  requestKey: string;
  model: string;
  generated: GeneratedArticle;
  createdAt: string;
};

/**
 * Durable, write-once storage for the paid result of an initial article generation.
 *
 * The opaque SHA-256 filename keeps user-controlled article IDs out of filesystem
 * paths. A checkpoint is immutable once committed: silently replacing it could
 * discard the only durable copy of a paid model response.
 */
export class InitialGenerationCheckpointStore {
  readonly #root: string;
  readonly #mutex = new KeyedMutex();

  constructor(root: string) {
    if (!root.trim()) throw new Error("Initial generation checkpoint root is required");
    this.#root = path.resolve(root);
  }

  async save(checkpoint: InitialGenerationCheckpoint): Promise<InitialGenerationCheckpoint> {
    const validated = parseCheckpoint(checkpoint);
    return this.#mutex.runExclusive(validated.articleId, async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const destination = this.#pathFor(validated.articleId);
      const existing = await readOptional(destination);
      if (existing) {
        const parsedExisting = parseCheckpointBytes(existing, destination);
        assertRequestedArticleId(parsedExisting, validated.articleId);
        if (canonicalJson(parsedExisting) !== canonicalJson(validated)) {
          throw new Error(
            `Initial generation checkpoint already exists for article ${validated.articleId}`,
          );
        }
        return parsedExisting;
      }

      const temporary = path.join(
        this.#root,
        `.${path.basename(destination)}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, `${canonicalJson(validated)}\n`, {
          flag: "wx",
          mode: 0o600,
          encoding: "utf8",
        });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return validated;
    });
  }

  async load(articleId: string): Promise<InitialGenerationCheckpoint | undefined> {
    const normalizedArticleId = parseLookupArticleId(articleId);
    return this.#mutex.runExclusive(normalizedArticleId, async () => {
      const checkpointPath = this.#pathFor(normalizedArticleId);
      const bytes = await readOptional(checkpointPath);
      if (!bytes) return undefined;
      const checkpoint = parseCheckpointBytes(bytes, checkpointPath);
      assertRequestedArticleId(checkpoint, normalizedArticleId);
      return checkpoint;
    });
  }

  async remove(articleId: string): Promise<void> {
    const normalizedArticleId = parseLookupArticleId(articleId);
    await this.#mutex.runExclusive(normalizedArticleId, async () => {
      await rm(this.#pathFor(normalizedArticleId), { force: true });
    });
  }

  #pathFor(articleId: string): string {
    const digest = createHash("sha256").update(articleId, "utf8").digest("hex");
    return path.join(this.#root, `${digest}.json`);
  }
}

function parseLookupArticleId(articleId: string): string {
  return boundedIdentifier.parse(articleId);
}

function parseCheckpoint(value: unknown): InitialGenerationCheckpoint {
  return initialGenerationCheckpointSchema.parse(value) as InitialGenerationCheckpoint;
}

function parseCheckpointBytes(bytes: Buffer, checkpointPath: string): InitialGenerationCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Initial generation checkpoint is not valid JSON: ${path.basename(checkpointPath)}`);
  }
  try {
    return parseCheckpoint(value);
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => issue.path.join(".") || "checkpoint").join(", ")
      : "checkpoint";
    throw new Error(
      `Initial generation checkpoint failed validation (${detail}): ${path.basename(checkpointPath)}`,
    );
  }
}

function assertRequestedArticleId(
  checkpoint: InitialGenerationCheckpoint,
  requestedArticleId: string,
): void {
  if (checkpoint.articleId !== requestedArticleId) {
    throw new Error(`Initial generation checkpoint article ID does not match ${requestedArticleId}`);
  }
}

function canonicalJson(checkpoint: InitialGenerationCheckpoint): string {
  return JSON.stringify(checkpoint);
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
