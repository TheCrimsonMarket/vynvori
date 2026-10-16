import { Client, type ClientConfig } from "@medusajs/framework/pg";

export const READINESS_CONNECT_MS = 1000;
export const READINESS_QUERY_MS = 2000;
export const READINESS_MAX_CONNECTIONS = 8;
let active = 0;

// A diagnostic owns its short-lived connection. It cannot consume or return a
// still-running query to Medusa's shared Knex pool. No retry or cancel connection.
export async function dependencyReadiness(config: Pick<ClientConfig, "connectionString" | "ssl">, signal?: AbortSignal) {
  if (signal?.aborted || active >= READINESS_MAX_CONNECTIONS) throw new Error("DEPENDENCY_UNAVAILABLE");
  active++;
  const client = new Client({ ...config, connectionTimeoutMillis: READINESS_CONNECT_MS,
    statement_timeout: READINESS_QUERY_MS, query_timeout: READINESS_QUERY_MS,
    application_name: "vynvori_dependency_readiness" });
  // Idle socket errors must be handled too; never emit a credential-bearing error.
  client.on("error", () => {});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.end();
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    if (signal?.aborted) throw new Error("DEPENDENCY_UNAVAILABLE");
    await client.query("SELECT 1");
    if (signal?.aborted) throw new Error("DEPENDENCY_UNAVAILABLE");
  } finally {
    signal?.removeEventListener("abort", abort);
    // In pinned pg, end() force-disconnects an active query; await its socket end
    // before reporting failure. query_timeout alone would abandon a live query.
    try { await close(); } finally { active--; }
  }
}
