import "server-only";
import { Client } from "pg";
import { identityMigrationPlan, identityMigrationTarget, applyIdentityMigrations, inspectIdentityMigrations, IdentityMigrationError } from "./identity-migrations";

// Never imported by application startup or the existing M2 migration command.
let client: Client | undefined;
try {
  const plan = identityMigrationPlan();
  if (process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--plan")) {
    console.log(JSON.stringify({ status: "PLAN_ONLY_NO_DATABASE", planSha256: plan.digest, ...plan.manifest }));
  } else {
    if (process.argv.length !== 3 || !["--apply", "--inspect"].includes(process.argv[2]!)) throw new IdentityMigrationError("TARGET_REJECTED");
    const inspecting = process.argv[2] === "--inspect", target = identityMigrationTarget(process.env, plan, inspecting ? "inspect" : "apply");
    client = new Client({ connectionString: target.url.toString(), connectionTimeoutMillis: 4000, statement_timeout: 15000, query_timeout: 16000, application_name: "vynvori-m1b-migration" });
    await client.connect(); console.log(JSON.stringify({ status: inspecting ? "INSPECTED_READ_ONLY" : "APPLIED", ...await (inspecting ? inspectIdentityMigrations(client) : applyIdentityMigrations(client, target)) }));
  }
} catch (error) { console.error(error instanceof IdentityMigrationError ? error.code : "IDENTITY_MIGRATION_UNAVAILABLE"); process.exitCode = 1; }
finally { if (client) await client.end(); }
