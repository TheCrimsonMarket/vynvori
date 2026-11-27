import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { featureDefaults } from "@vynvori/shared/public";
import * as ledgerCore from "../src/ledger-core";
import * as ledgerMigrations from "../src/ledger-migrations";
import * as ledgerQuotes from "../src/ledger-quotes";
import { issueQuote, renewQuote } from "../src/ledger-quotes";
import { dropLedger, freshLedger, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet, grantSyntheticCredits } from "./ledger-fixture";

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
const ledgerSources = new Set(["packages/db/src/ledger-core.ts", "packages/db/src/ledger-migrations.ts", "packages/db/src/ledger-quotes.ts"]);
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
  for (const [name, module] of Object.entries({ ledgerCore, ledgerMigrations, ledgerQuotes })) {
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

test("ledger-quotes exposes exactly the reviewed API (S3; a new export must be added here deliberately)", () => {
  assert.deepEqual(Object.keys(ledgerQuotes).sort(), ["assessQuoteForAuthorization", "getLatestQuoteVersion", "getQuote", "issueQuote", "renewQuote"]);
});

// ADR-0021 S3 addendum A4: BINDING for every future step. All command kinds implemented anywhere under packages/db/src.
const KNOWN_LEDGER_COMMAND_KINDS = ["grant_credits", "quote_issue", "quote_renew"];
const dbSrcFiles = () => readdirSync(join(root, "packages/db/src")).filter(f => f.endsWith(".ts"));

test("A4(2): every commandKind literal under packages/db/src is a registered command kind (S5/S6 must register theirs here)", () => {
  const found = new Set<string>();
  for (const file of dbSrcFiles()) {
    const text = readFileSync(join(root, "packages/db/src", file), "utf8");
    for (const match of text.matchAll(/commandKind:\s*["']([a-z][a-z0-9_]{0,63})["']/g)) found.add(match[1]!);
  }
  assert.ok(found.size > 0, "scanner found at least one commandKind literal");
  for (const kind of found) assert.ok(KNOWN_LEDGER_COMMAND_KINDS.includes(kind), `unregistered command kind: ${kind}`);
});

test("A4(3): INSERT INTO the quote tables appears only in ledger-quotes.ts", () => {
  const pattern = /INSERT\s+INTO\s+\S*ledger_quote(?:s|_allocations|_lineages)\b/i;
  for (const file of dbSrcFiles()) {
    const text = readFileSync(join(root, "packages/db/src", file), "utf8");
    if (file === "ledger-quotes.ts") { assert.match(text, pattern, "ledger-quotes.ts should itself insert into the quote tables"); continue; }
    assert.doesNotMatch(text, pattern, file);
  }
});

test("A4(1): every ledger command locks the wallet row FOR UPDATE before touching any other ledger table", { skip: ledgerTarget.skip }, async () => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("isolation");
  try {
    const log: string[] = [];
    const spyDb = {
      query: (text: string, values?: unknown[]) => { log.push(text.trim()); return client.query(text, values); },
      acquire: async () => ({
        query: (text: string, values?: unknown[]) => { log.push(text.trim()); return client.query(text, values); },
        release: () => undefined,
      }),
    };
    const WALLET_LOCK = /^SELECT 1 FROM vynvori_ledger\.wallets WHERE user_id = \$1 FOR UPDATE$/;
    // Scoped to the command's own transaction (after BEGIN/SET LOCAL), per the A4 wording: ensureWallet's own
    // upsert runs as a separate statement before BEGIN and is not part of this invariant.
    const firstLedgerStatement = () => {
      const beginIndex = log.findIndex(q => /^BEGIN$/i.test(q));
      const after = beginIndex === -1 ? log : log.slice(beginIndex + 1);
      return after.find(q => /^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q));
    };

    const source = await registerSyntheticGrantSource(client);
    const user = await syntheticProfileWithWallet(client);

    log.length = 0;
    await grantSyntheticCredits(spyDb, { userId: user, grantSourceId: source, sourceRef: "lock-order-grant", units: 1 });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "grant_credits");

    const promoView = (quoteId: string, quoteVersionId: string, offsetMs: number) => ({
      quoteId, quoteVersionId, issuedAt: new Date(Date.now() + offsetMs).toISOString(), expiresAt: new Date(Date.now() + offsetMs + 3_600_000).toISOString(),
      pricePolicyVersion: "lock-order-pv", capabilitySnapshotId: "lock-order-cap", creditsQuoted: 0, maxHoldUnits: 0,
      wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: new Date(Date.now() + offsetMs).toISOString(), walletRevision: "0" },
      consentTextVersion: "lock-order-ctv", included: [], excluded: [],
      authorizationHint: { quoteId, checkedAt: new Date(Date.now() + offsetMs).toISOString(), canAuthorize: false, reasonCodes: [], quoteVersionId },
      offerKind: "promo_single_preview" as const, directionId: "lock-order-direction", finalRenderIncludedInThisPurchase: false, physicalGarmentIncluded: false,
    });

    log.length = 0;
    await issueQuote(spyDb, { userId: user, quoteView: promoView("lock-order-quote", "lock-order-quote-v1", 0), modelRef: "lock-order-model", allocations: [], idempotencyKey: "lock-order-issue-key-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "quote_issue");

    log.length = 0;
    await renewQuote(spyDb, { userId: user, quoteId: "lock-order-quote", expectedLatestVersionNo: 1, quoteView: promoView("lock-order-quote", "lock-order-quote-v2", 1), modelRef: "lock-order-model", allocations: [], idempotencyKey: "lock-order-renew-key-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "quote_renew");
  } finally { await client.end().catch(() => undefined); await dropLedger("isolation"); }
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
