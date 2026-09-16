import { booleanCell, stringCell, type SheetRecord } from "../domain/article.js";

const AUTO_QA_ACTOR_ID = "auto-qa-repair";

/**
 * Proves that the current manual QA gate was created by the bounded automatic
 * repair workflow, rather than clearing a gate that was already set by a human.
 */
export function hasRecoverableSystemExhaustionGate(
  article: SheetRecord,
  events: SheetRecord[],
  contentHash: string,
): boolean {
  if (
    !booleanCell(article.manual_required) ||
    stringCell(article.status) !== "failed_qa" ||
    stringCell(article.qa_status) !== "fail"
  ) {
    return false;
  }

  const terminal = [...events]
    .sort((left, right) => right.__rowNumber - left.__rowNumber)
    .find((event) => {
      if (
        stringCell(event.article_id) !== stringCell(article.article_id) ||
        stringCell(event.event_type) !== "auto_qa_repair_exhausted" ||
        stringCell(event.actor_type) !== "system" ||
        stringCell(event.actor_id) !== AUTO_QA_ACTOR_ID ||
        stringCell(event.provider) !== "system"
      ) {
        return false;
      }
      const payload = eventPayload(event);
      return stringField(payload, "output_hash") === contentHash &&
        stringField(payload, "qa_blockers") === stringCell(article.qa_blockers) &&
        Boolean(stringField(payload, "started_event_id"));
    });
  if (!terminal) return false;

  const terminalPayload = eventPayload(terminal);
  const startedEventId = stringField(terminalPayload, "started_event_id");
  const started = events.find((event) =>
    event.__rowNumber < terminal.__rowNumber &&
    stringCell(event.article_id) === stringCell(article.article_id) &&
    stringCell(event.event_id) === startedEventId &&
    stringCell(event.event_type) === "auto_qa_repair_started" &&
    stringCell(event.actor_type) === "system" &&
    stringCell(event.actor_id) === AUTO_QA_ACTOR_ID &&
    stringCell(event.provider) === "openai" &&
    stringCell(event.provider_object_id) === stringCell(terminal.provider_object_id)
  );
  if (!started) return false;

  // A legacy start does not prove who owned the manual gate. Only the durable
  // pre-attempt snapshot can authorize recovering the system-created flag.
  if (eventPayload(started).manual_required_before_attempt !== false) return false;

  return events.every((event) => {
    if (event.__rowNumber <= terminal.__rowNumber) return true;
    if (
      stringCell(event.event_type) !== "auto_qa_repair_notified" ||
      stringCell(event.actor_type) !== "system" ||
      stringCell(event.actor_id) !== AUTO_QA_ACTOR_ID ||
      stringCell(event.provider) !== "telegram"
    ) {
      return false;
    }
    return stringField(eventPayload(event), "terminal_event_id") === stringCell(terminal.event_id);
  });
}

function eventPayload(event: SheetRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stringCell(event.payload_json)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : "";
}
