import http from "node:http";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function workerConfig(env) {
  if (!["local", "staging"].includes(env.M2_ENV) || env.VERCEL_ENV === "production") throw new Error("M2 environment required");
  if (!env.M2_PROCESSING_TOKEN || env.M2_PROCESSING_TOKEN.length < 32 || /[\r\n]/.test(env.M2_PROCESSING_TOKEN)) throw new Error("Strong processing token required");
  if (env.K_SERVICE && env.M2_ENV !== "staging") throw new Error("Cloud Run requires staging mode");
  for (const key of Object.keys(env)) {
    if (key.startsWith("VYNVORI_") && env[key] !== undefined && env[key] !== "false") throw new Error("Operational features disabled");
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  return { token: env.M2_PROCESSING_TOKEN, port, host: env.K_SERVICE || env.M2_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1" };
}
export function dryRun(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "fixture,requestId,version" ||
      body.version !== 1 || body.fixture !== "m2-synthetic-v1" || typeof body.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.requestId)) throw new Error("Invalid dry-run schema");
  return { version: 1, requestId: body.requestId, fixture: body.fixture, status: "dry_run", sha256: createHash("sha256").update("vynvori:m2:synthetic:v1").digest("hex"), printed: false };
}
export function createWorker(config, log = value => console.log(JSON.stringify(value))) {
  const expected = Buffer.from(`Bearer ${config.token}`);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const candidate = req.headers["x-correlation-id"];
    const correlationId = typeof candidate === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(candidate) ? candidate : randomUUID();
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-correlation-id": correlationId });
      res.end(JSON.stringify(body));
      log({ severity: status >= 500 ? "ERROR" : "INFO", event: "m2.request", correlationId, status });
    };
    if (req.url === "/health" && req.method === "GET") return send(200, { version: 1, status: "ok" });
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { code: "UNAUTHORIZED" });
    if (req.url === "/ready" && req.method === "GET") return send(200, { version: 1, status: "ready", mode: "synthetic_only" });
    if (req.url !== "/v1/dry-run" || req.method !== "POST") return send(404, { code: "NOT_FOUND" });
    if (req.headers["content-type"] !== "application/json") return send(415, { code: "JSON_REQUIRED" });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) { send(413, { code: "BODY_TOO_LARGE" }); req.resume(); return; }
        chunks.push(chunk);
      }
      const result = dryRun(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return send(200, result);
    } catch { return send(400, { code: "INVALID_SYNTHETIC_REQUEST" }); }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = workerConfig(process.env);
  const server = createWorker(config);
  server.listen(config.port, config.host);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
}
