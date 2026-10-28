import { APIError } from "openai";

export const OPENAI_FAILURE_REASONS = [
  "openai_credit_balance_exhausted",
  "openai_spend_or_usage_limit_reached",
  "openai_temporary_rate_limit",
  "openai_authentication_failed",
] as const;

export type OpenAiFailureReason = (typeof OPENAI_FAILURE_REASONS)[number];

/**
 * Classify only structured OpenAI SDK errors. Other providers (Google/Ghost)
 * also use HTTP status codes, so message matching alone must never label them
 * as OpenAI failures.
 */
export function classifyOpenAiApiError(error: unknown): OpenAiFailureReason | undefined {
  if (!(error instanceof APIError)) return undefined;

  const code = normalizeSignal(error.code);
  const type = normalizeSignal(error.type);
  const message = sanitizedMessage(error.message);
  const details = `${code} ${type} ${message}`.trim();

  if (error.status === 429 && (
    /\b(?:credit_balance_exhausted|credits?_exhausted|insufficient_credits?)\b/u.test(details) ||
    /\bno credits? remaining\b/u.test(message) ||
    /\b(?:credit balance|credits?)\b.{0,40}\b(?:empty|exhausted|depleted|insufficient)\b/u.test(message) ||
    /\b(?:not enough|insufficient) credits?\b/u.test(message)
  )) {
    return "openai_credit_balance_exhausted";
  }

  if (error.status === 429 && (
    /\b(?:insufficient_quota|quota_exceeded|usage_limit_reached|spend_limit_reached|billing_hard_limit_reached)\b/u
      .test(details) ||
    /\b(?:organization|org|project|monthly|billing)?\s*(?:spend|spending|usage|hard) limit\b/u.test(message) ||
    /\b(?:current )?quota\b.{0,50}\b(?:exceeded|reached)\b/u.test(message) ||
    /\b(?:exceeded|reached)\b.{0,50}\b(?:quota|usage limit|spend(?:ing)? limit)\b/u.test(message)
  )) {
    return "openai_spend_or_usage_limit_reached";
  }

  if (error.status === 429 && (
    /\b(?:rate_limit_exceeded|rate_limited|too_many_requests|slow_down)\b/u.test(details) ||
    /\b(?:rate limit|too many requests|slow down)\b/u.test(message)
  )) {
    return "openai_temporary_rate_limit";
  }

  if ((error.status === 401 || error.status === 403) && (
    /\b(?:invalid_api_key|authentication_error|unauthorized|permission_denied)\b/u.test(details) ||
    /\b(?:incorrect|invalid|revoked) api key\b/u.test(message) ||
    /\b(?:authentication|authorization) (?:failed|error|required)\b/u.test(message) ||
    error.status === 401 ||
    error.status === 403
  )) {
    return "openai_authentication_failed";
  }

  return undefined;
}

function normalizeSignal(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "_") : "";
}

/** Keep fallback matching bounded and strip values that could contain credentials. */
function sanitizedMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 2_000)
    .replace(/https?:\/\/\S+/giu, " <url> ")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, " <secret> ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
