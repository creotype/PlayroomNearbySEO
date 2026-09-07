import type { Article } from "../domain/article.js";
import { booleanCell, displayDateCell, numberCell, stringCell } from "../domain/article.js";

const KEYWORDS_SHEET_GID = 910000002;
const LINK_INVENTORY_SHEET_GID = 910000004;
const SETTINGS_SHEET_GID = 910000005;
const ARTICLES_SHEET_GID = 910000001;

export function articleSheetUrl(spreadsheetId: string, rowNumber?: number): string {
  const range = rowNumber ? `A${rowNumber}:AO${rowNumber}` : "A2:AO";
  return sheetRangeUrl(spreadsheetId, ARTICLES_SHEET_GID, range);
}

export function keywordSheetUrl(spreadsheetId: string, rowNumber?: number): string {
  const range = rowNumber ? `A${rowNumber}:T${rowNumber}` : "A2:T";
  return sheetRangeUrl(spreadsheetId, KEYWORDS_SHEET_GID, range);
}

export function linkInventorySheetUrl(spreadsheetId: string): string {
  return sheetRangeUrl(spreadsheetId, LINK_INVENTORY_SHEET_GID, "A2:N");
}

export function settingsSheetUrl(spreadsheetId: string): string {
  return sheetRangeUrl(spreadsheetId, SETTINGS_SHEET_GID, "A2:F");
}

export function articleCard(
  article: Article,
  spreadsheetId: string,
  reviewPolicy: { deadlineHours?: number; publicationTime?: string } = {},
): string {
  const row = article.__rowNumber;
  const sheetUrl = articleSheetUrl(spreadsheetId, row);
  const schedule = displayDateCell(article.scheduled_publish_at) || "после согласования";
  const blockers = stringCell(article.qa_blockers);
  const canApprove = stringCell(article.qa_status) === "pass" && !booleanCell(article.manual_required);
  return [
    `📝 <b>SEO draft · ${escapeHtml(article.article_id)}</b>`,
    `${escapeHtml(article.locale.toUpperCase())} · ${escapeHtml(stringCell(article.primary_keyword))}`,
    `<b>Title:</b> ${escapeHtml(article.title)}`,
    `<b>QA:</b> ${numberCell(article.quality_score).toFixed(1)}/10 · ${escapeHtml(stringCell(article.qa_status))}`,
    blockers ? `<b>Blockers:</b> ${escapeHtml(blockers)}` : "",
    `<b>Publish:</b> ${escapeHtml(schedule)}`,
    "",
    `<a href="${sheetUrl}">Открыть строку в Google Sheets</a>`,
    "",
    `⏳ На проверку — ${reviewPolicy.deadlineHours ?? 48} часов с момента этой карточки. Затем статья будет автоматически согласована и поставлена на ближайшие ${escapeHtml(reviewPolicy.publicationTime ?? "10:00")}.`,
    "",
    canApprove
      ? "/regenerate комментарий — переписать эту статью\n/approve — согласовать эту статью"
      : "/regenerate комментарий — переписать эту статью. /approve останется заблокирован до успешной QA.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function articleStatusMessage(article: Article): string {
  return [
    `ℹ️ <b>${escapeHtml(article.article_id)}</b>`,
    `Status: <code>${escapeHtml(article.status)}</code>`,
    `QA: ${numberCell(article.quality_score).toFixed(1)}/10 · ${escapeHtml(stringCell(article.qa_status))}`,
    stringCell(article.qa_blockers) ? `Blockers: ${escapeHtml(stringCell(article.qa_blockers))}` : "",
    stringCell(article.public_url) ? `<a href="${escapeHtml(stringCell(article.public_url))}">Открыть статью</a>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character] ?? character;
  });
}

function sheetRangeUrl(spreadsheetId: string, gid: number, range: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${gid}&range=${range}`;
}
