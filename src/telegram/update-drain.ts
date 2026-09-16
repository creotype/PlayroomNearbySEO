export class UpdateDrain {
  #active = 0;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | undefined;

  enter(): () => void {
    if (this.#active === 0) {
      this.#idle = new Promise<void>((resolve) => {
        this.#resolveIdle = resolve;
      });
    }
    this.#active += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#active -= 1;
      if (this.#active === 0) {
        this.#resolveIdle?.();
        this.#resolveIdle = undefined;
      }
    };
  }

  wait(): Promise<void> {
    return this.#idle;
  }
}
