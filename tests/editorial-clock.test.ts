import { describe, expect, it } from "vitest";
import {
  latestEditorialSlot,
  nextPublicationAt,
  parseLocalClockTime,
  parseWeekdays,
} from "../src/services/editorial-clock.js";

describe("editorial clock", () => {
  it("resolves Monday and Friday slots in Europe/Belgrade and catches up the latest missed slot", () => {
    const slot = latestEditorialSlot(
      new Date("2026-09-07T08:01:00.000Z"),
      "Europe/Belgrade",
      [1, 5],
      { hour: 10, minute: 0 },
    );
    expect(slot).toMatchObject({
      localDate: "2026-09-07",
      key: "editorial-slot:2026-09-07T10:00@Europe/Belgrade",
    });
    expect(slot?.scheduledAt.toISOString()).toBe("2026-09-07T08:00:00.000Z");

    const catchup = latestEditorialSlot(
      new Date("2026-09-06T10:00:00.000Z"),
      "Europe/Belgrade",
      [1, 5],
      { hour: 10, minute: 0 },
    );
    expect(catchup?.localDate).toBe("2026-09-04");
  });

  it("uses the first 10:00 after a 48-hour review deadline", () => {
    const deadline = new Date("2026-09-09T08:05:00.000Z"); // 10:05 Belgrade
    expect(
      nextPublicationAt(deadline, "Europe/Belgrade", { hour: 10, minute: 0 }).toISOString(),
    ).toBe("2026-09-10T08:00:00.000Z");
  });

  it("keeps 10:00 wall-clock time across the Europe/Belgrade DST boundary", () => {
    const winter = latestEditorialSlot(
      new Date("2026-01-05T09:01:00.000Z"),
      "Europe/Belgrade",
      [1, 5],
      { hour: 10, minute: 0 },
    );
    const summer = latestEditorialSlot(
      new Date("2026-03-30T08:01:00.000Z"),
      "Europe/Belgrade",
      [1, 5],
      { hour: 10, minute: 0 },
    );

    expect(winter?.scheduledAt.toISOString()).toBe("2026-01-05T09:00:00.000Z");
    expect(summer?.scheduledAt.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });

  it("parses validated clock and weekday settings", () => {
    expect(parseLocalClockTime("10:00", "09:00")).toEqual({ hour: 10, minute: 0 });
    expect(parseWeekdays("5,1,5", [2])).toEqual([1, 5]);
    expect(() => parseLocalClockTime("25:00", "10:00")).toThrow("Invalid local clock time");
    expect(() => parseWeekdays("1,9", [1, 5])).toThrow("Invalid editorial weekdays");
  });
});
