import test from "node:test";
import assert from "node:assert/strict";
import { creativeMigrationUrl } from "../src/migration-config";
import { databaseUrl } from "@vynvori/shared/infrastructure";

const host = "ep-synthetic.us-east-1.aws.neon.tech";
const direct = `postgresql://vynvori_migration:synthetic-test-only@${host}/vynvori_creative_staging?sslmode=verify-full`;
const env = { M2_ENV: "staging", M2_CREATIVE_MIGRATION_DATABASE_URL: direct, M2_CREATIVE_MIGRATION_DATABASE_HOST: host };
test("staging migrations cannot fall back to runtime or root owner credentials", () => {
  assert.throws(() => creativeMigrationUrl({ M2_ENV: "staging", DATABASE_URL: direct, M2_CREATIVE_DATABASE_URL: direct }));
  assert.equal(creativeMigrationUrl(env).hostname, host);
  assert.throws(() => databaseUrl(env, "CREATIVE"), "runtime cannot silently consume migration credentials");
  assert.throws(() => creativeMigrationUrl({ ...env, M2_CREATIVE_DATABASE_URL: direct }));
});
test("migration guard rejects production, wrong database, wrong host, pooler and weak TLS", () => {
  for (const patch of [
    { M2_ENV: "production" }, { VERCEL_ENV: "production" }, { VYNVORI_PAYMENTS_LIVE: "true" },
    { M2_CREATIVE_MIGRATION_DATABASE_HOST: "other.neon.tech" },
    { M2_CREATIVE_MIGRATION_DATABASE_URL: direct.replace("vynvori_creative_staging", "vynvori_medusa_staging") },
    { M2_CREATIVE_MIGRATION_DATABASE_URL: direct.replace("sslmode=verify-full", "sslmode=require") },
    { M2_CREATIVE_MIGRATION_DATABASE_URL: direct.replace("vynvori_migration:", "neondb_owner:") },
    { M2_CREATIVE_MIGRATION_DATABASE_URL: direct.replace(host, "ep-synthetic-pooler.us-east-1.aws.neon.tech"), M2_CREATIVE_MIGRATION_DATABASE_HOST: "ep-synthetic-pooler.us-east-1.aws.neon.tech" },
  ]) assert.throws(() => creativeMigrationUrl({ ...env, ...patch }));
});
test("existing local CI migration input stays loopback and synthetic", () => {
  const local = { M2_ENV: "local", M2_CREATIVE_DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1/vynvori_creative_staging" };
  assert.equal(creativeMigrationUrl(local).hostname, "127.0.0.1");
  assert.throws(() => creativeMigrationUrl({ ...local, M2_CREATIVE_MIGRATION_DATABASE_URL: direct }));
});
