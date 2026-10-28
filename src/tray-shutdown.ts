export class TrayShutdownProtocol {
  #buffer = "";
  #triggered = false;

  push(chunk: string): boolean {
    if (this.#triggered) return false;
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line === "shutdown") {
        this.#triggered = true;
        return true;
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return false;
  }
}
