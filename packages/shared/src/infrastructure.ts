import "server-only";

export type Dependency = "medusa" | "database" | "storage" | "processing";
export type ReadinessV1 = Readonly<{
  version: 1; service: Dependency;
  status: "ready" | "unconfigured" | "unavailable";
  code: "OK" | "NOT_CONFIGURED" | "DEPENDENCY_UNAVAILABLE";
}>;
export async function readiness(service: Dependency, check: (() => Promise<void>) | undefined): Promise<ReadinessV1> {
  if (!check) return { version: 1, service, status: "unconfigured", code: "NOT_CONFIGURED" };
  try { await check(); return { version: 1, service, status: "ready", code: "OK" }; }
  catch { return { version: 1, service, status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" }; }
}
export type InfraEnv = Readonly<Record<string, string | undefined>>;
export function required(env: InfraEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${key}`);
  return value;
}
export function scope(env: InfraEnv): "local" | "staging" {
  if (env.M2_ENV !== "local" && env.M2_ENV !== "staging") throw new Error("M2_ENV must be local or staging");
  if (env.VERCEL_ENV === "production") throw new Error("M2 dependencies cannot run in Vercel production");
  for (const key of Object.keys(env)) {
    if (/^(NEXT_PUBLIC_|PUBLIC_).*M2_|^M2_.*(LIVE|PRODUCTION|AUTH_ENABLED)$/.test(key)) throw new Error("Unsupported public or operational M2 configuration");
    if (key.startsWith("VYNVORI_") && env[key] !== undefined && env[key] !== "false") throw new Error("Operational features must remain disabled");
  }
  return env.M2_ENV;
}
export function serviceOrigin(value: string, deployment: "local" | "staging"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid service origin"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (deployment === "staging" ? url.protocol !== "https:" || local : url.protocol !== "http:" || !local)) throw new Error("Unsafe service origin");
  return url;
}
export function databaseUrl(env: InfraEnv, kind: "CREATIVE" | "MEDUSA"): URL {
  const deployment = scope(env);
  let url: URL;
  try { url = new URL(required(env, `M2_${kind}_DATABASE_URL`)); } catch { throw new Error(`Invalid M2_${kind}_DATABASE_URL`); }
  const expectedName = kind === "CREATIVE" ? "vynvori_creative_staging" : required(env, "M2_MEDUSA_DATABASE_NAME");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== expectedName || !url.username || !url.password || url.hash) throw new Error("Database isolation validation failed");
  if (deployment === "staging") {
    if (url.hostname !== required(env, `M2_${kind}_DATABASE_HOST`) || url.searchParams.get("sslmode") !== "verify-full") throw new Error("Staging requires pinned database host and verified TLS");
    if (kind === "CREATIVE" && (!url.hostname.endsWith(".neon.tech") || !url.hostname.includes("-pooler."))) throw new Error("Creative staging requires a pooled Neon endpoint");
  } else if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Local database must use loopback");
  if (kind === "MEDUSA" && /creative/i.test(expectedName)) throw new Error("Medusa database cannot be the creative database");
  const other = env[`M2_${kind === "CREATIVE" ? "MEDUSA" : "CREATIVE"}_DATABASE_URL`];
  if (other) {
    let peer: URL;
    try { peer = new URL(other); } catch { throw new Error("Invalid peer database configuration"); }
    if (url.hostname === peer.hostname && url.port === peer.port && url.pathname === peer.pathname) throw new Error("Commerce and creative databases must differ");
  }
  return url;
}
