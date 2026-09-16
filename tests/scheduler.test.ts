import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { Scheduler } from "../src/services/scheduler.js";

describe("Scheduler shutdown", () => {
  it("drains the active tick and refuses new ticks after stop", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = vi.fn(async () => blocked);
    const scheduler = new Scheduler(60_000, { error: vi.fn() } as unknown as Logger);
    scheduler.add("blocked", job);

    const tick = scheduler.tick();
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await Promise.all([tick, stopping]);
    await scheduler.tick();
    expect(job).toHaveBeenCalledTimes(1);
  });
});
