import { createHash } from "node:crypto";

export const ARTICLE_STATUSES = [
  "backlog",
  "brief_ready",
  "generating",
  "draft",
  "qa_pending",
  "needs_review",
  "revision_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed_generation",
  "failed_qa",
  "failed_publish",
  "conflict",
  "cancelled",
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];
export type CellValue = string | number | boolean | null;
export type SheetRecord = Record<string, CellValue> & { __rowNumber: number };

export type Article = SheetRecord & {
  article_id: string;
  locale: string;
  status: ArticleStatus;
  title: string;
  slug: string;
  body_markdown: string;
};

const PUBLISHABLE_FIELDS = [
  "locale",
  "title",
  "slug",
  "excerpt",
  "seo_title",
  "meta_description",
  "body_markdown",
  "tags",
  "source_urls",
  "internal_links",
  "feature_image_url",
  "feature_image_alt",
  "scheduled_publish_at",
] as const;

export function articleContentHash(article: SheetRecord): string {
  const canonical = Object.fromEntries(
    PUBLISHABLE_FIELDS.map((field) => [field, normalizeValue(article[field])]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function stringCell(value: CellValue | undefined): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function numberCell(value: CellValue | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function booleanCell(value: CellValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "да", "истина"].includes(String(value).trim().toLowerCase());
}

export function parseListCell(value: CellValue | undefined): string[] {
  return stringCell(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function dateCell(
  value: CellValue | undefined,
  timeZone = "Europe/Belgrade",
): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return googleSerialToDate(value, timeZone);
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return googleSerialToDate(Number(raw), timeZone);
  const localMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (localMatch) {
    return zonedWallClockToDate(
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] ?? 0),
      timeZone,
    );
  }
  const localizedMatch = raw.match(
    /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ ,T]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (localizedMatch) {
    return zonedWallClockToDate(
      Number(localizedMatch[3]),
      Number(localizedMatch[2]),
      Number(localizedMatch[1]),
      Number(localizedMatch[4]),
      Number(localizedMatch[5]),
      Number(localizedMatch[6] ?? 0),
      timeZone,
    );
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function displayDateCell(
  value: CellValue | undefined,
  timeZone = "Europe/Belgrade",
): string {
  const parsed = dateCell(value, timeZone);
  return parsed
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(parsed)
    : "";
}

function normalizeValue(value: CellValue | undefined): CellValue {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : (value ?? "");
}

function googleSerialToDate(serial: number, timeZone: string): Date | undefined {
  if (!Number.isFinite(serial)) return undefined;
  const wallClock = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
  return zonedWallClockToDate(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth() + 1,
    wallClock.getUTCDate(),
    wallClock.getUTCHours(),
    wallClock.getUTCMinutes(),
    wallClock.getUTCSeconds(),
    timeZone,
  );
}

function zonedWallClockToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wallClockUtc;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    instant = wallClockUtc - (representedUtc - instant);
  }
  return new Date(instant);
}
