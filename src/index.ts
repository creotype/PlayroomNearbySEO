import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";
import { startApp } from "./app.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = await startApp(config, logger);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.shutdown(signal).finally(() => process.exit(0));
  });
}
