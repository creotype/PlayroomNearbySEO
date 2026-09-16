import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { startApp } from "./app.js";
import { TrayShutdownProtocol } from "./tray-shutdown.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = await startApp(config, logger);
let shutdownRequested = false;

function shutdownAndExit(source: string, exitCode = 0): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  void app.shutdown(source).finally(() => process.exit(exitCode));
}

void app.terminalFailure.then(() => shutdownAndExit("terminal-failure", 1));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdownAndExit(signal);
  });
}

if (process.env.TRAY_MANAGED === "1") {
  const protocol = new TrayShutdownProtocol();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (protocol.push(String(chunk))) shutdownAndExit("tray");
  });
}
