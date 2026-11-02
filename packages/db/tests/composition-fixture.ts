import { readFileSync } from "node:fs";
import { Client } from "pg";
import { applyCompositionMigrations, compositionMigrationPlan } from "../src/composition-migrations";

export const connectionString = process.env.M3_TEST_POSTGRES_URL;
/** Disposable loopback database only. Rebuilds M1b identity DDL then applies the reviewed M3 plan. */
export async function freshComposition(database = "vynvori_m3_migration_test"): Promise<Client> {
  const url = new URL(connectionString!); url.pathname = "/" + database;
  if (url.hostname !== "127.0.0.1" || !["vynvori_m3_migration_test", "vynvori_m3_service_test"].includes(database) || url.username !== "synthetic") throw new Error("Refusing non-disposable database");
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  await client.query("DROP SCHEMA IF EXISTS vynvori_composition CASCADE; DROP SCHEMA IF EXISTS vynvori_composition_migrations CASCADE; DROP SCHEMA IF EXISTS vynvori_identity CASCADE");
  const plan = JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")) as { migrations: { file: string }[] };
  for (const migration of plan.migrations) await client.query(readFileSync(new URL("../auth-migrations/" + migration.file, import.meta.url), "utf8"));
  await applyCompositionMigrations(client, { database, role: "synthetic", planSha256: compositionMigrationPlan().digest });
  return client;
}
