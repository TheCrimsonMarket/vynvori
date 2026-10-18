import "server-only";
import { databaseUrl, required, scope, type InfraEnv } from "@vynvori/shared/infrastructure";

// Production and the root DATABASE_URL are never migration fallbacks. Existing
// loopback CI may share a synthetic login; staging needs separate direct input.
export function creativeMigrationUrl(env: InfraEnv): URL {
  const deployment = scope(env);
  if (deployment === "local" && !env.M2_CREATIVE_MIGRATION_DATABASE_URL) return databaseUrl(env, "CREATIVE");
  let url: URL;
  try { url = new URL(required(env, "M2_CREATIVE_MIGRATION_DATABASE_URL")); }
  catch { throw new Error("Invalid creative migration connection"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/vynvori_creative_staging" ||
      !url.username || !url.password || url.hash) throw new Error("Creative migration isolation failed");
  if (deployment === "staging") {
    if (url.hostname !== required(env, "M2_CREATIVE_MIGRATION_DATABASE_HOST") ||
        !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler.") ||
        url.searchParams.get("sslmode") !== "verify-full" || !/^vynvori_[a-z0-9_]+$/.test(url.username)) throw new Error("Creative migration requires a pinned direct scoped Neon connection");
    if (env.M2_CREATIVE_DATABASE_URL && new URL(env.M2_CREATIVE_DATABASE_URL).username === url.username) throw new Error("Staging runtime and migration identities must differ");
  } else if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Local migration requires loopback");
  return url;
}
