import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
// Compiler-only defaults: never used by start/dev/migrate; compiled config reads runtime env.
const env = process.env.M2_ENV ? { ...process.env } : {
  ...process.env, M2_ENV: "local", M2_MEDUSA_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:9/vynvori_medusa_staging",
  M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging", M2_MEDUSA_JWT_SECRET: randomBytes(32).toString("hex"), M2_MEDUSA_COOKIE_SECRET: randomBytes(32).toString("hex"),
  M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: "http://localhost:9000", M2_MEDUSA_AUTH_CORS: "http://localhost:9000",
};
const cli = require.resolve("@medusajs/cli/cli.js");
env.MEDUSA_DISABLE_TELEMETRY = "true";
const child = spawn(process.execPath, [cli, "build"], { env, stdio: "inherit" });
child.once("exit", code => { process.exitCode = code ?? 1; });
