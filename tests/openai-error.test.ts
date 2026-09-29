import { APIConnectionError, APIError } from "openai";
import { describe, expect, it } from "vitest";
import { classifyOpenAiApiError } from "../src/generation/openai-error.js";

function apiError(
  status: number,
  error: { message: string; code?: string; type?: string },
): APIError {
  return APIError.generate(status, { error }, undefined, new Headers());
}

describe("OpenAI API error classification", () => {
  it("recognizes an exhausted prepaid credit balance before generic quota signals", () => {
    const error = apiError(429, {
      code: "insufficient_quota",
      type: "insufficient_quota",
      message: "You have no credits remaining. Add credits to continue using the API.",
    });

    expect(classifyOpenAiApiError(error)).toBe("openai_credit_balance_exhausted");
  });

  it.each([
    [
      { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota." },
      "openai_spend_or_usage_limit_reached",
    ],
    [
      { code: "usage_limit_reached", message: "The project usage limit has been reached." },
      "openai_spend_or_usage_limit_reached",
    ],
    [
      { code: "rate_limit_exceeded", message: "Rate limit reached for requests per minute." },
      "openai_temporary_rate_limit",
    ],
  ] as const)("classifies a 429 provider response", (body, expected) => {
    expect(classifyOpenAiApiError(apiError(429, body))).toBe(expected);
  });

  it("uses the sanitized SDK message when code and type are absent", () => {
    const error = apiError(429, {
      message: "Too many requests; slow down. See https://example.test/?token=sk-secret-value.",
    });

    expect(classifyOpenAiApiError(error)).toBe("openai_temporary_rate_limit");
  });

  it.each([401, 403])("recognizes OpenAI authentication/access status %i", (status) => {
    expect(classifyOpenAiApiError(apiError(status, { message: "Access denied." })))
      .toBe("openai_authentication_failed");
  });

  it("does not classify another provider from matching text alone", () => {
    expect(classifyOpenAiApiError(new Error("429 You have no credits remaining"))).toBeUndefined();
  });

  it("does not treat an ambiguous connection failure as a safe provider rejection", () => {
    const error = new APIConnectionError({ message: "no credits remaining" });
    expect(classifyOpenAiApiError(error)).toBeUndefined();
  });

  it("does not treat an OpenAI 5xx message as a safe billing rejection", () => {
    expect(classifyOpenAiApiError(apiError(500, { message: "no credits remaining" }))).toBeUndefined();
  });
});
