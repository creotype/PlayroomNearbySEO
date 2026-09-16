import { describe, expect, it } from "vitest";
import { UpdateDrain } from "../src/telegram/update-drain.js";

describe("UpdateDrain", () => {
  it("waits for every active Telegram update and tolerates duplicate leave calls", async () => {
    const drain = new UpdateDrain();
    const leaveFirst = drain.enter();
    const leaveSecond = drain.enter();
    let idle = false;
    void drain.wait().then(() => {
      idle = true;
    });

    leaveFirst();
    leaveFirst();
    await Promise.resolve();
    expect(idle).toBe(false);
    leaveSecond();
    await drain.wait();
    expect(idle).toBe(true);
  });
});
