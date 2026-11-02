// Compiler-only Medusa validation in a new external temporary tree. No npm, image or deployment action.
import { cp, mkdir, writeFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const destination = join(tmpdir(), "VYNVORI-M1b-20261019", `medusa-source-build-${randomUUID()}`);
const backend = join(destination, "apps", "medusa");
await mkdir(backend, { recursive: true });
for (const name of ["src", "scripts", "package.json", "tsconfig.json", "medusa-config.ts"]) await cp(join(root, "apps", "medusa", name), join(backend, name), { recursive: true });
await mkdir(join(destination, "packages", "commerce", "src"), { recursive: true });
await cp(join(root, "packages", "commerce", "src", "central-identity-core.ts"), join(destination, "packages", "commerce", "src", "central-identity-core.ts"));
await cp(join(root, "packages", "commerce", "src", "medusa-proof-core.ts"), join(destination, "packages", "commerce", "src", "medusa-proof-core.ts"));
await symlink(join(root, "node_modules"), join(destination, "node_modules"), "junction");
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, NODE_ENV: "development", MEDUSA_DISABLE_TELEMETRY: "true",
  XDG_CONFIG_HOME: join(destination, "private-cli-config"), XDG_CACHE_HOME: join(destination, "private-cli-cache"),
  M2_ENV: "local", M2_MEDUSA_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:9/vynvori_medusa_staging", M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
  M2_MEDUSA_JWT_SECRET: randomBytes(32).toString("hex"), M2_MEDUSA_COOKIE_SECRET: randomBytes(32).toString("hex"),
  M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: "http://localhost:9000", M2_MEDUSA_AUTH_CORS: "http://localhost:9000",
};
console.log("Medusa compiler-only build started in a new temporary tree; no dependency installation or live configuration");
try {
  const result = await exec(process.execPath, ["scripts/build.mjs"], { cwd: backend, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(destination, "compiler.stdout.private.log"), result.stdout, { flag: "wx" });
  await writeFile(join(destination, "compiler.stderr.private.log"), result.stderr, { flag: "wx" });
  const smoke = join(destination, "compiled-provider-smoke.cjs");
  await writeFile(smoke, `const assert = require('node:assert/strict');
const Provider = require(process.argv[2]).default;
assert.equal(Provider.identifier, 'tcm');
const instance = new Provider({}, { enabled:false, issuer:'', apiBase:'', clientId:'', clientSecret:'', audience:'' }, async () => { throw new Error('Unexpected network'); });
instance.authenticate({headers:{authorization:'Bearer synthetic'}}, {}).then(result => {
  assert.deepEqual(result, {success:false,error:'Authentication disabled'});
  console.log('PASS_COMPILED_NODE_PROVIDER_DISABLED');
}).catch(() => { process.exitCode = 1; });
`, { flag: "wx" });
  const loaded = await exec(process.execPath, [smoke, join(backend, ".medusa", "server", "src", "modules", "tcm-auth", "service.js")], { cwd: backend, env, windowsHide: true, timeout: 10000 });
  if (loaded.stdout.trim() !== "PASS_COMPILED_NODE_PROVIDER_DISABLED") throw new Error("Compiled provider probe failed");
  const receipt = { status: "PASS_COMPILER_AND_COMPILED_DISABLED_PROVIDER", output: destination, runtimeRegistration: false, install: false, database: "NOT_CONNECTED_LOOPBACK_PORT9_CONFIG_ONLY", deployment: false };
  await writeFile(join(destination, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(receipt));
} catch (error) {
  await writeFile(join(destination, "compiler.stdout.private.log"), typeof error?.stdout === "string" ? error.stdout : "", { flag: "wx" });
  await writeFile(join(destination, "compiler.stderr.private.log"), typeof error?.stderr === "string" ? error.stderr : "", { flag: "wx" });
  console.error(`Medusa compiler-only build failed; private compiler diagnostics retained at ${destination}`); process.exitCode = 1;
}
