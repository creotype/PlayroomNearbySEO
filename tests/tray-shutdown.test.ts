import { describe, expect, it } from "vitest";
import { TrayShutdownProtocol } from "../src/tray-shutdown.js";

describe("tray shutdown protocol", () => {
  it("accepts one exact newline-terminated shutdown command across chunks", () => {
    const protocol = new TrayShutdownProtocol();

    expect(protocol.push("shut")).toBe(false);
    expect(protocol.push("down\r\n")).toBe(true);
    expect(protocol.push("shutdown\n")).toBe(false);
  });

  it("ignores arbitrary stdin and near-matches", () => {
    const protocol = new TrayShutdownProtocol();

    expect(protocol.push("hello\n shutdown\nshutdown-now\n")).toBe(false);
    expect(protocol.push("shutdown")).toBe(false);
    expect(protocol.push("\n")).toBe(true);
  });
});
