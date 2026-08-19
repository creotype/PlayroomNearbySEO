import type { Article } from "../domain/article.js";
import { booleanCell, displayDateCell, numberCell, stringCell } from "../domain/article.js";

export function articleCard(article: Article, spreadsheetId: string): string {
  const row = article.__rowNumber;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=910000001&range=A${row}:AO${row}`;
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
    canApprove
      ? "Если черновик устраивает, нажмите «Согласовать»."
      : "Нажмите «Исправить ИИ» или поправьте строку вручную; согласование останется заблокировано до успешной QA.",
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
