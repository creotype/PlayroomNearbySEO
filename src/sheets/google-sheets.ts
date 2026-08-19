import { Buffer } from "node:buffer";
import { google, type sheets_v4 } from "googleapis";
import type { AppConfig } from "../config.js";
import type { Article, ArticleStatus, CellValue, SheetRecord } from "../domain/article.js";
import { ARTICLE_STATUSES, stringCell } from "../domain/article.js";

const REQUIRED_HEADERS = {
  articles: [
    "article_id",
    "locale",
    "status",
    "title",
    "slug",
    "body_markdown",
    "qa_status",
    "qa_blockers",
    "quality_score",
    "content_hash",
    "telegram_message_id",
    "ghost_post_id",
    "updated_at",
  ],
  keywords: ["keyword_id", "locale", "primary_keyword", "status", "article_id", "updated_at"],
  settings: ["setting_key", "value", "value_type", "environment", "description", "updated_at"],
  facts_guardrails: ["rule_id", "locale", "severity", "rule_text", "status"],
  link_inventory: ["link_id", "environment", "locale", "url", "status", "allow_internal_link"],
  events: [
    "event_id",
    "article_id",
    "event_type",
    "from_status",
    "to_status",
    "actor_type",
    "actor_id",
    "provider",
    "provider_object_id",
    "message",
    "payload_json",
    "created_at",
  ],
} as const;

type SheetName = keyof typeof REQUIRED_HEADERS;

type SheetTable = {
  headers: string[];
  headerIndex: Map<string, number>;
  rows: SheetRecord[];
};

export type AuditEvent = {
  event_id: string;
  article_id: string;
  event_type: string;
  from_status?: string;
  to_status?: string;
  actor_type: string;
  actor_id?: string;
  provider?: string;
  provider_object_id?: string;
  message?: string;
  payload_json?: string;
  created_at: string;
};

export class GoogleSheetsStore {
  readonly #sheets: sheets_v4.Sheets;
  readonly #spreadsheetId: string;
  readonly #headerCache = new Map<SheetName, string[]>();

  constructor(config: AppConfig) {
    const credentials = config.googleServiceAccountJson
      ? parseServiceAccount(config.googleServiceAccountJson)
      : undefined;
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      ...(credentials ? { credentials } : {}),
      ...(config.googleApplicationCredentials
        ? { keyFile: config.googleApplicationCredentials }
        : {}),
    });
    this.#sheets = google.sheets({ version: "v4", auth });
    this.#spreadsheetId = config.spreadsheetId;
  }

  async verifySchema(): Promise<void> {
    await Promise.all(
      (Object.keys(REQUIRED_HEADERS) as SheetName[]).map(async (sheet) => {
        const table = await this.#readTable(sheet, true);
        const missing = REQUIRED_HEADERS[sheet].filter((header) => !table.headerIndex.has(header));
        if (missing.length > 0) throw new Error(`${sheet}: missing headers ${missing.join(", ")}`);
      }),
    );
  }

  async listArticles(statuses?: readonly ArticleStatus[]): Promise<Article[]> {
    const table = await this.#readTable("articles");
    return table.rows
      .filter((row) => Boolean(stringCell(row.article_id)))
      .filter((row) => {
        const status = stringCell(row.status);
        return !statuses || statuses.includes(status as ArticleStatus);
      })
      .map(toArticle);
  }

  async findArticle(articleId: string): Promise<Article | undefined> {
    const normalized = articleId.trim().toLowerCase();
    return (await this.listArticles()).find(
      (article) => article.article_id.toLowerCase() === normalized,
    );
  }

  async findArticleByTelegramMessageId(messageId: number): Promise<Article | undefined> {
    return (await this.listArticles()).find(
      (article) => Number(article.telegram_message_id) === messageId,
    );
  }

  async patchArticle(articleId: string, patch: Record<string, CellValue>): Promise<Article> {
    const table = await this.#readTable("articles");
    const matches = table.rows.filter(
      (row) => stringCell(row.article_id).toLowerCase() === articleId.trim().toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one article ${articleId}; found ${matches.length}`);
    }
    await this.#patchRow("articles", table, matches[0]!, patch);
    const updated = await this.findArticle(articleId);
    if (!updated) throw new Error(`Article disappeared after update: ${articleId}`);
    return updated;
  }

  async patchArticleAndAppendEvent(
    articleId: string,
    patch: Record<string, CellValue>,
    event: AuditEvent,
  ): Promise<Article> {
    const [articles, events] = await Promise.all([
      this.#readTable("articles"),
      this.#readTable("events", true),
    ]);
    const matches = articles.rows.filter(
      (row) => stringCell(row.article_id).toLowerCase() === articleId.trim().toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one article ${articleId}; found ${matches.length}`);
    }
    const eventValues: Record<string, CellValue> = {
      event_id: event.event_id,
      article_id: event.article_id,
      event_type: event.event_type,
      from_status: event.from_status ?? "",
      to_status: event.to_status ?? "",
      actor_type: event.actor_type,
      actor_id: event.actor_id ?? "",
      provider: event.provider ?? "",
      provider_object_id: event.provider_object_id ?? "",
      message: event.message ?? "",
      payload_json: event.payload_json ?? "",
      created_at: event.created_at,
    };
    const eventRow = events.rows.find((row) => !stringCell(row.event_id))?.__rowNumber ?? events.rows.length + 2;
    const data = [
      ...this.#patchData("articles", articles, matches[0]!, patch),
      {
        range: `'events'!A${eventRow}:${columnName(events.headers.length)}${eventRow}`,
        values: [events.headers.map((header) => prepareSheetValue(header, eventValues[header] ?? ""))],
      },
    ];
    await this.#sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.#spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    });
    const updated = await this.findArticle(articleId);
    if (!updated) throw new Error(`Article disappeared after atomic approval: ${articleId}`);
    return updated;
  }

  async appendArticle(values: Record<string, CellValue>): Promise<void> {
    await this.#appendRecord("articles", values);
  }

  async listKeywords(statuses?: readonly string[]): Promise<SheetRecord[]> {
    const table = await this.#readTable("keywords");
    return table.rows
      .filter((row) => Boolean(stringCell(row.keyword_id)))
      .filter((row) => !statuses || statuses.includes(stringCell(row.status)));
  }

  async patchKeyword(keywordId: string, patch: Record<string, CellValue>): Promise<void> {
    const table = await this.#readTable("keywords");
    const matches = table.rows.filter(
      (row) => stringCell(row.keyword_id).toLowerCase() === keywordId.trim().toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one keyword ${keywordId}; found ${matches.length}`);
    }
    await this.#patchRow("keywords", table, matches[0]!, patch);
  }

  async getSettings(): Promise<Map<string, CellValue>> {
    const table = await this.#readTable("settings");
    return new Map(
      table.rows
        .map((row) => [stringCell(row.setting_key), row.value ?? ""] as const)
        .filter(([key]) => Boolean(key)),
    );
  }

  async listGuardrails(): Promise<SheetRecord[]> {
    return (await this.#readTable("facts_guardrails")).rows;
  }

  async listLinks(): Promise<SheetRecord[]> {
    return (await this.#readTable("link_inventory")).rows;
  }

  async appendEvent(event: AuditEvent): Promise<void> {
    await this.#appendRecord("events", {
      event_id: event.event_id,
      article_id: event.article_id,
      event_type: event.event_type,
      from_status: event.from_status ?? "",
      to_status: event.to_status ?? "",
      actor_type: event.actor_type,
      actor_id: event.actor_id ?? "",
      provider: event.provider ?? "",
      provider_object_id: event.provider_object_id ?? "",
      message: event.message ?? "",
      payload_json: event.payload_json ?? "",
      created_at: event.created_at,
    });
  }

  async listEvents(articleId: string): Promise<SheetRecord[]> {
    return (await this.#readTable("events")).rows.filter(
      (row) => stringCell(row.article_id) === articleId,
    );
  }

  async #readTable(sheet: SheetName, refreshHeaders = false): Promise<SheetTable> {
    const response = await this.#sheets.spreadsheets.values.get({
      spreadsheetId: this.#spreadsheetId,
      range: `'${sheet}'!A1:AZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = response.data.values ?? [];
    const headers = (values[0] ?? []).map((value) => String(value).trim());
    validateHeaders(sheet, headers);
    if (refreshHeaders || !this.#headerCache.has(sheet)) this.#headerCache.set(sheet, headers);
    const headerIndex = new Map(headers.map((header, index) => [header, index]));
    const rows = values.slice(1).map((valuesRow, index) => {
      const record: Record<string, CellValue> = { __rowNumber: index + 2 };
      headers.forEach((header, columnIndex) => {
        const raw = valuesRow[columnIndex];
        record[header] = raw === undefined || raw === null ? "" : (raw as CellValue);
      });
      return record as SheetRecord;
    });
    return { headers, headerIndex, rows };
  }

  async #patchRow(
    sheet: SheetName,
    table: SheetTable,
    row: SheetRecord,
    patch: Record<string, CellValue>,
  ): Promise<void> {
    const data = this.#patchData(sheet, table, row, patch);
    if (data.length === 0) return;
    await this.#sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.#spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    });
  }

  #patchData(
    sheet: SheetName,
    table: SheetTable,
    row: SheetRecord,
    patch: Record<string, CellValue>,
  ): sheets_v4.Schema$ValueRange[] {
    return Object.entries(patch).map(([header, value]) => {
      const columnIndex = table.headerIndex.get(header);
      if (columnIndex === undefined) throw new Error(`${sheet}: unknown column ${header}`);
      return {
        range: `'${sheet}'!${columnName(columnIndex + 1)}${row.__rowNumber}`,
        values: [[prepareSheetValue(header, value)]],
      };
    });
  }

  async #appendRecord(sheet: SheetName, values: Record<string, CellValue>): Promise<void> {
    const headers = (await this.#readTable(sheet, true)).headers;
    await this.#sheets.spreadsheets.values.append({
      spreadsheetId: this.#spreadsheetId,
      range: `'${sheet}'!A:${columnName(headers.length)}`,
      valueInputOption: "RAW",
      insertDataOption: "OVERWRITE",
      requestBody: {
        values: [headers.map((header) => prepareSheetValue(header, values[header] ?? ""))],
      },
    });
  }
}

function validateHeaders(sheet: SheetName, headers: string[]): void {
  if (headers.length === 0) throw new Error(`${sheet}: header row is empty`);
  const duplicates = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicates.length > 0) throw new Error(`${sheet}: duplicate headers ${[...new Set(duplicates)].join(", ")}`);
}

function toArticle(row: SheetRecord): Article {
  const status = stringCell(row.status);
  if (!ARTICLE_STATUSES.includes(status as ArticleStatus)) {
    throw new Error(`Article ${stringCell(row.article_id)} has unknown status: ${status}`);
  }
  const article = row as Article;
  article.article_id = stringCell(row.article_id);
  article.locale = stringCell(row.locale);
  article.status = status as ArticleStatus;
  article.title = stringCell(row.title);
  article.slug = stringCell(row.slug);
  article.body_markdown = stringCell(row.body_markdown);
  return article;
}

function columnName(oneBasedIndex: number): string {
  let index = oneBasedIndex;
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function parseServiceAccount(raw: string): Record<string, unknown> {
  const decoded = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw.trim(), "base64").toString("utf8");
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  return parsed as Record<string, unknown>;
}

const DATE_HEADERS = new Set([
  "scheduled_publish_at",
  "review_deadline",
  "approved_at",
  "ghost_updated_at",
  "published_at",
  "created_at",
  "updated_at",
  "planned_publish_at",
  "used_at",
  "verified_at",
  "valid_until",
  "last_checked_at",
  "scheduled_at",
]);

export function prepareSheetValue(header: string, value: CellValue): CellValue {
  if (value === null) return "";
  if (typeof value !== "string" || !DATE_HEADERS.has(header) || !value.trim()) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return dateToGoogleSerial(parsed, "Europe/Belgrade");
}

function dateToGoogleSerial(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const wallClock = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return (wallClock - Date.UTC(1899, 11, 30)) / 86_400_000;
}
