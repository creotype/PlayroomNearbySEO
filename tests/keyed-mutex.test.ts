import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";

describe("KeyedMutex", () => {
  it("serializes work for the same article", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = mutex.runExclusive("A", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = mutex.runExclusive("A", async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
