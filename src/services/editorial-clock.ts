import { dateCell, stringCell, type CellValue } from "../domain/article.js";

export type LocalClockTime = {
  hour: number;
  minute: number;
};

export type EditorialSlot = {
  key: string;
  localDate: string;
  scheduledAt: Date;
};

export function parseLocalClockTime(value: CellValue | undefined, fallback: string): LocalClockTime {
  const raw = stringCell(value) || fallback;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) throw new Error(`Invalid local clock time: ${raw}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local clock time: ${raw}`);
  return { hour, minute };
}

export function parseWeekdays(value: CellValue | undefined, fallback: readonly number[]): number[] {
  const raw = stringCell(value);
  const days = raw
    ? raw.split(/[\s,;]+/u).filter(Boolean).map(Number)
    : [...fallback];
  if (
    days.length === 0 ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error(`Invalid editorial weekdays: ${raw || fallback.join(",")}`);
  }
  return [...new Set(days)].sort((left, right) => left - right);
}

/** Returns the latest configured weekly slot at or before now, including DST conversion. */
export function latestEditorialSlot(
  now: Date,
  timeZone: string,
  weekdays: readonly number[],
  time: LocalClockTime,
): EditorialSlot | undefined {
  const today = zonedParts(now, timeZone);
  const wallDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
  for (let daysBack = 0; daysBack < 7; daysBack += 1) {
    const candidate = new Date(wallDate.getTime() - daysBack * 86_400_000);
    if (!weekdays.includes(candidate.getUTCDay())) continue;
    const localDate = isoDate(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate());
    const scheduledAt = zonedWallClockToDate(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth() + 1,
      candidate.getUTCDate(),
      time.hour,
      time.minute,
      0,
      timeZone,
    );
    if (scheduledAt.getTime() > now.getTime()) continue;
    return {
      key: `editorial-slot:${localDate}T${twoDigits(time.hour)}:${twoDigits(time.minute)}@${timeZone}`,
      localDate,
      scheduledAt,
    };
  }
  return undefined;
}

/** First configured wall-clock time at or after the supplied instant. */
export function nextPublicationAt(
  notBefore: Date,
  timeZone: string,
  time: LocalClockTime,
): Date {
  const parts = zonedParts(notBefore, timeZone);
  let candidate = zonedWallClockToDate(
    parts.year,
    parts.month,
    parts.day,
    time.hour,
    time.minute,
    0,
    timeZone,
  );
  if (candidate.getTime() >= notBefore.getTime()) return candidate;
  const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 86_400_000);
  candidate = zonedWallClockToDate(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    time.hour,
    time.minute,
    0,
    timeZone,
  );
  return candidate;
}

export function reviewStartedAt(
  telegramMessageId: CellValue | undefined,
  updatedAt: CellValue | undefined,
  timeZone: string,
): Date | undefined {
  const messageId = Number(telegramMessageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return undefined;
  return dateCell(updatedAt, timeZone);
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
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
  for (let iteration = 0; iteration < 3; iteration += 1) {
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

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
