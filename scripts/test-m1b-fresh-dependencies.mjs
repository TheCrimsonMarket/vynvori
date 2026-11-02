// Independent extraction/install verification. Does not modify this checkout, approval seals or live configuration.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile), root = fileURLToPath(new URL("..", import.meta.url));
const resume = process.argv[2] === "--resume";
assert.ok(resume ? process.argv.length === 4 : process.argv.length === 2);
const output = resume ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), "VYNVORI-M1b-fresh-")), workspace = join(output, "workspace");
assert.equal(dirname(output).toLowerCase(), resolve(tmpdir()).toLowerCase()); assert.ok(basename(output).startsWith("VYNVORI-M1b-fresh-"));
const hash = data => createHash("sha256").update(data).digest("hex");
const lockBytes = await readFile(join(root, "package-lock.json")), manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")), lock = JSON.parse(lockBytes);
const workspaces = new Set(manifest.workspaces);
if (resume) {
  const original = await readFile(join(output, "receipt.json"), "utf8"), previous = JSON.parse(original);
  assert.equal(previous.npmCi, "PASS_NORMAL_LIFECYCLE"); assert.equal(previous.lockSha256, hash(lockBytes)); assert.equal(previous.workspace, workspace);
  assert.equal(hash(await readFile(join(workspace, "package-lock.json"))), hash(lockBytes)); await access(join(workspace, "node_modules/@medusajs/js-sdk/package.json"));
  await writeFile(join(output, "receipt-before-resume-" + Date.now() + ".json"), original, { flag: "wx" });
}
for (const entry of Object.values(lock.packages)) {
  if (entry.link) assert.ok(workspaces.has(entry.resolved));
  else if (entry.resolved) { const url = new URL(entry.resolved); assert.equal(url.origin, "https://registry.npmjs.org"); assert.equal(url.username + url.password, ""); }
}
for (const name of ["package.json", "package-lock.json", "eslint.config.mjs"]) await cp(join(root, name), join(workspace, name));
const excluded = new Set(["node_modules", ".next", ".medusa", ".git", "dist", "output", "coverage", ".cache", ".npmrc"]);
for (const directory of ["apps", "packages", "services", "design/reference", "scripts", "deploy"])
  await cp(join(root, directory), join(workspace, directory), { recursive: true, filter: path => !excluded.has(basename(path)) && !basename(path).startsWith(".env") && !basename(path).endsWith(".log") });
for (const directory of workspaces) {
  const pkg = JSON.parse(await readFile(join(workspace, directory, "package.json"), "utf8"));
  assert.ok(!["preinstall", "install", "postinstall", "prepare"].some(key => pkg.scripts?.[key]), "Unexpected workspace install hook requires review");
}
const userConfig = join(output, "empty-user.npmrc"), globalConfig = join(output, "empty-global.npmrc");
await writeFile(userConfig, ""); await writeFile(globalConfig, "");
const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"); await access(npm);
const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", MEDUSA_DISABLE_TELEMETRY: "true", npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_registry: "https://registry.npmjs.org/" });
async function command(name, args, { audit = false, timeout = 180000 } = {}) {
  console.log("[fresh verification] " + name + " started; logs private");
  let result;
  try { const data = await exec(process.execPath, args, { cwd: workspace, env, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }); result = { ...data, exitCode: 0 }; }
  catch (error) { result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: typeof error.code === "number" ? error.code : -1 }; }
  await writeFile(join(output, name + ".stdout.private.log"), result.stdout, { mode: 0o600 }); await writeFile(join(output, name + ".stderr.private.log"), result.stderr, { mode: 0o600 });
  assert.ok(audit || result.exitCode === 0, name + " failed; private diagnostics retained at " + output);
  return result;
}
const receipt = { date: "2026-10-19", status: "IN_PROGRESS", node: process.version, lockSha256: hash(lockBytes), workspace, output, resumedVerifiedInstall: resume, registry: "https://registry.npmjs.org/", userNpmCredentials: "NOT_LOADED_EMPTY_CONFIG", liveConfigurationCopied: false, approvalSealChanged: false, deployment: false };
try {
  receipt.npm = (await exec(process.execPath, [npm, "--version"], { env, windowsHide: true })).stdout.trim();
  if (!resume) await command("npm-ci", [npm, "ci", "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 300000 }); receipt.npmCi = "PASS_NORMAL_LIFECYCLE";
  assert.equal(hash(await readFile(join(workspace, "package-lock.json"))), receipt.lockSha256);
  // Node resolves test globs itself on the supported runtime, independent of shell expansion.
  await command("identity-suites", ["--conditions=react-server", "--import", "tsx", "--test", "--test-reporter=dot", "packages/shared/tests/config.test.ts", "packages/commerce/tests/*.test.ts", "apps/web/tests/*.test.ts", "apps/medusa/tests/*.test.ts"]);
  receipt.identityTests = "PASS_SHARED_COMMERCE_WEB_MEDUSA";
  await command("lint", [npm, "run", "lint"]); receipt.lint = "PASS";
  await command("typecheck", [npm, "run", "typecheck"]); receipt.typecheck = "PASS";
  for (const [name, args] of [["production-audit", ["audit", "--omit=dev", "--json"]], ["all-audit", ["audit", "--json"]]]) {
    const audit = await command(name, [npm, ...args], { audit: true });
    const parsed = JSON.parse(audit.stdout); assert.ok(parsed.metadata?.vulnerabilities && !parsed.error, "Audit unavailable");
    receipt[name] = { exitCode: audit.exitCode, vulnerabilities: parsed.metadata.vulnerabilities,
      highCritical: Object.entries(parsed.vulnerabilities ?? {}).filter(([, row]) => ["high", "critical"].includes(row.severity)).map(([name, row]) => ({ name, severity: row.severity, isDirect: row.isDirect, fixAvailable: row.fixAvailable })) };
  }
  receipt.status = "PASS_FRESH_INSTALL_AND_CHECKS_AUDITS_REQUIRE_REVIEW";
} catch (error) { receipt.status = "FAILED"; receipt.failure = error instanceof Error ? error.message : "Verification unavailable"; process.exitCode = 1; }
finally { await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt)); }
