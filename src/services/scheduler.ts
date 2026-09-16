import type { Logger } from "pino";

export class Scheduler {
  readonly #jobs: Array<{ name: string; run: () => Promise<void> }> = [];
  #timer: NodeJS.Timeout | undefined;
  #activeTick: Promise<void> | undefined;
  #stopping = false;

  constructor(
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  add(name: string, run: () => Promise<void>): void {
    this.#jobs.push({ name, run });
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#activeTick;
  }

  async tick(): Promise<void> {
    if (this.#stopping) return;
    if (this.#activeTick) return this.#activeTick;
    const activeTick = this.#runJobs();
    this.#activeTick = activeTick;
    try {
      await activeTick;
    } finally {
      if (this.#activeTick === activeTick) this.#activeTick = undefined;
    }
  }

  async #runJobs(): Promise<void> {
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
  }
}
