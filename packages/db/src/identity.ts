import "server-only";
import { Pool } from "pg";
import { databaseUrl, scope, type InfraEnv } from "@vynvori/shared/infrastructure";
export { identityStateStore } from "./auth-state";
export { commerceMappingStore } from "./commerce-mappings";

/** No startup DDL. This pool is separate from the existing M2 probe runtime role. */
export function connectIdentityDatabase(env: InfraEnv) {
  const url = databaseUrl(env, "CREATIVE");
  if (scope(env) === "staging" && decodeURIComponent(url.username) !== "vynvori_identity_runtime_scoped") throw new Error("Identity database requires the dedicated scoped runtime identity");
  const pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 4000, idleTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 6000, application_name: "vynvori-m1b" });
  return { pool, close: () => pool.end() };
}
