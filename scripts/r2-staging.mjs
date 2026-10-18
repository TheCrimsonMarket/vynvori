// Usage: node --conditions=react-server --import tsx scripts/r2-staging.mjs [journal.json]
// Supply server-only M2_R2_* and M2_ENV in the environment; this does not load .env.
import { runR2Probe } from "./r2-operator.ts";
try {
  if (process.argv.length > 3) throw new Error("INVALID_ARGUMENTS");
  console.log(JSON.stringify(await runR2Probe(process.env, process.argv[2]), null, 2));
} catch (error) {
  // Do not print raw SDK errors, request URLs, headers or credentials.
  console.error(JSON.stringify({ status: "BLOCKED_PRESERVE_JOURNAL", code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : "R2_PROBE_FAILED", http: error.$metadata?.httpStatusCode }));
  process.exitCode = 1;
}
