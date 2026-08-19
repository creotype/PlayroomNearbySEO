import type { Logger } from "pino";

export class Scheduler {
  readonly #jobs: Array<{ name: string; run: () => Promise<void> }> = [];
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  add(name: string, run: () => Promise<void>): void {
    this.#jobs.push({ name, run });
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const job of this.#jobs) {
        try {
          await job.run();
        } catch (error) {
          this.logger.error(
            { job: job.name, err: error instanceof Error ? error.message : String(error) },
            "Scheduled job failed",
          );
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
