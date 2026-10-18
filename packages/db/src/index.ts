import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseUrl, type InfraEnv } from "@vynvori/shared/infrastructure";
import * as schema from "./schema";
import { creativeMigrationUrl } from "./migration-config";
export function connectDatabase(env: InfraEnv) {
  return connection(databaseUrl(env, "CREATIVE"));
}
export function connectMigrationDatabase(env: InfraEnv) {
  return connection(creativeMigrationUrl(env));
}
function connection(url: URL) {
  const pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 4000, idleTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 6000, application_name: "vynvori-m2" });
  return { pool, db: drizzle(pool, { schema }), close: () => pool.end(),
    async ready() {
      const result = await pool.query("SELECT current_database() AS name, to_regclass('vynvori_infrastructure.synthetic_probes') AS probes");
      if (result.rows[0]?.name !== "vynvori_creative_staging" || !result.rows[0]?.probes) throw new Error("Database not migrated");
    },
  };
}
export { probes } from "./schema";
