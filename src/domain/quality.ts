export const GENERATED_QA_BLOCKER_CODES = [
  "unsupported_factual_claim",
  "invented_venue_fact",
  "missing_authoritative_source",
  "missing_source_url",
  "missing_internal_link",
  "invalid_internal_link",
  "internal_link_not_in_body",
  "external_url_in_body",
  "tracking_parameters_in_source_url",
  "malformed_markdown_link",
  "language_mismatch",
  "serbian_not_latin",
  "absolute_or_guaranteed_claim",
  "meta_description_incomplete",
] as const;

export type GeneratedQaBlockerCode = (typeof GENERATED_QA_BLOCKER_CODES)[number];

const SEMANTIC_GENERATED_QA_BLOCKER_CODES = new Set<GeneratedQaBlockerCode>([
  "unsupported_factual_claim",
  "invented_venue_fact",
  "missing_authoritative_source",
  "language_mismatch",
  "serbian_not_latin",
  "absolute_or_guaranteed_claim",
]);

export function isSemanticGeneratedQaBlocker(
  blocker: GeneratedQaBlockerCode,
): boolean {
  return SEMANTIC_GENERATED_QA_BLOCKER_CODES.has(blocker);
}
