import { createServer, type Server } from "node:http";
import type { Logger } from "pino";

export type ReadinessState = {
  ready: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
};

export function startHealthServer(
  port: number,
  getReadiness: () => ReadinessState,
  logger: Logger,
): Server {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      respondJson(response, 200, { ok: true });
      return;
    }
    if (request.url === "/readyz") {
      const readiness = getReadiness();
      respondJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }
    respondJson(response, 404, { ok: false, error: "not_found" });
  });
  server.listen(port, "0.0.0.0", () => logger.info({ port }, "Health server listening"));
  return server;
}

function respondJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
