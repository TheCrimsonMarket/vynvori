import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { featureDefaults } from "@vynvori/shared/public";
import * as ledgerCore from "../src/ledger-core";
import * as ledgerMigrations from "../src/ledger-migrations";

// ADR-0021 D13: W1 ships a library plus schema, not a feature. No database needed; this test always runs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "docs", "tests", "output"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name), info = statSync(path);
    if (info.isDirectory()) walk(path, out); else if (/\.(ts|tsx|mts|js|mjs|cjs|json)$/.test(name) && !/\.test\.[tj]s$/.test(name)) out.push(path);
  }
  return out;
}
const ledgerSources = new Set(["packages/db/src/ledger-core.ts", "packages/db/src/ledger-migrations.ts"]);
const files = ["apps", "packages", "services", "scripts"].flatMap(dir => { try { return walk(join(root, dir)); } catch { return []; } });

test("no app or non-test module imports the ledger (D13)", () => {
  assert.ok(files.length > 20, "scanner found the repository sources");
  const importer = /(@vynvori\/db\/ledger|\bledger-core\b|\bledger-migrations\b|\/ledger-(?:quotes|reservations|settlement|evidence|entitlements|promo|invariants))/;
  const offenders = files.map(f => relative(root, f)).filter(f => !ledgerSources.has(f) && importer.test(readFileSync(join(root, f), "utf8")));
  // The only permitted mention outside the ledger sources is the package.json exports map that publishes the subpaths.
  assert.deepEqual(offenders.filter(f => f !== "packages/db/package.json"), []);
  const apps = files.map(f => relative(root, f)).filter(f => f.startsWith("apps/"));
  assert.ok(apps.length > 0, "scanner found app sources");
  assert.deepEqual(apps.filter(f => /@vynvori\/db\/ledger|vynvori_ledger/.test(readFileSync(join(root, f), "utf8"))), [], "nothing under apps/ touches the ledger");
});

test("packages/db/src exports no numeric constants and nothing that mints or registers credits", () => {
  for (const [name, module] of Object.entries({ ledgerCore, ledgerMigrations })) {
    for (const [key, value] of Object.entries(module)) {
      assert.ok(typeof value !== "number" && typeof value !== "bigint", `${name}.${key} must not be a numeric constant`);
      assert.doesNotMatch(key, /mint|synthetic|testing|register.*source|price|rate|package/i, `${name}.${key}`);
    }
  }
  const src = join(root, "packages/db/src");
  for (const file of readdirSync(src).filter(f => f.endsWith(".ts"))) {
    const text = readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, /export\s+const\s+\w+\s*(?::[^=]+)?=\s*-?\d/, `${file} exports a numeric constant`);
  }
  assert.ok(!readdirSync(src).some(f => /ledger-testing/.test(f)), "no ledger-testing style module in src/");
});

test("ledger-core exposes exactly the reviewed API (a new export, e.g. another minting path, must be added here deliberately)", () => {
  assert.deepEqual(Object.keys(ledgerCore).sort(), ["LedgerBusinessRejection", "LedgerError", "PERSISTABLE_REJECTION_CODES", "appendGrantEntry", "assertPositiveUnits", "canonicalRequestHash", "classifyCommitFailure", "classifyStatementFailure", "ensureWallet", "getWalletSummary", "parseSafeUnits", "runLedgerCommand"]);
});

test("no source module can register a grant source or write the grant-source registry", () => {
  const src = join(root, "packages/db/src");
  for (const file of readdirSync(src).filter(f => f.endsWith(".ts"))) {
    const text = readFileSync(join(src, file), "utf8");
    assert.doesNotMatch(text, /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\S*ledger_grant_sources/i, file);
    assert.doesNotMatch(text, /session_replication_role|DISABLE\s+TRIGGER|SECURITY\s+DEFINER/i, file);
  }
  assert.ok(!Object.keys(ledgerCore).some(key => /registerGrantSource|addGrantSource/i.test(key)));
});

test("every feature flag still defaults to false", () => {
  assert.ok(Object.keys(featureDefaults).length > 0);
  for (const [flag, value] of Object.entries(featureDefaults)) assert.equal(value, false, flag);
});
