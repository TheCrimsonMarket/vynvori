import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { featureDefaults } from "@vynvori/shared/public";
import * as ledgerCore from "../src/ledger-core";
import * as ledgerMigrations from "../src/ledger-migrations";
import * as ledgerQuotes from "../src/ledger-quotes";
import * as ledgerPromo from "../src/ledger-promo";
import * as ledgerReservations from "../src/ledger-reservations";
import * as ledgerEntitlements from "../src/ledger-entitlements";
import * as ledgerSettlement from "../src/ledger-settlement";
import * as ledgerEvidence from "../src/ledger-evidence";
import * as ledgerInvariants from "../src/ledger-invariants";
import { holdReservation, settleReservation } from "../src/ledger-settlement";
import { authorizeQuote, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { issueQuote, renewQuote } from "../src/ledger-quotes";
import { dropLedger, freshLedger, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet, grantSyntheticCredits } from "./ledger-fixture";
import { consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

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
const ledgerSources = new Set(["packages/db/src/ledger-core.ts", "packages/db/src/ledger-migrations.ts", "packages/db/src/ledger-quotes.ts", "packages/db/src/ledger-promo.ts", "packages/db/src/ledger-reservations.ts", "packages/db/src/ledger-settlement.ts", "packages/db/src/ledger-evidence.ts", "packages/db/src/ledger-entitlements.ts", "packages/db/src/ledger-invariants.ts"]);
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
  for (const [name, module] of Object.entries({ ledgerCore, ledgerMigrations, ledgerQuotes, ledgerPromo, ledgerReservations, ledgerSettlement, ledgerEvidence, ledgerEntitlements, ledgerInvariants })) {
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

test("ledger-reservations exposes exactly the reviewed API (S5; no settle, hold, grant or package-transition export)", () => {
  assert.deepEqual(Object.keys(ledgerReservations).sort(), ["authorizeQuote", "getReservation", "recordWorkflowRef", "releaseReservation"]);
});

test("ledger-entitlements exposes exactly the reviewed API (S7: slot and bundle-transition commands; no grant, settle, hold or credit-moving export)", () => {
  assert.deepEqual(Object.keys(ledgerEntitlements).sort(), ["beginBundleClosure", "closeBundleWithForfeiture", "consumeRefinementSlot", "getBundleState", "markRefinementPending", "markRefinementUnknown", "openRefinements", "recordBundleDelivery", "reopenBundleAfterUnchargedFinal", "restoreRefinementSlot", "skipRefinementSlot"]);
});

test("ledger-invariants exposes exactly the reviewed API (S8: two read-only checks; no repair, release or resolve export)", () => {
  assert.deepEqual(Object.keys(ledgerInvariants).sort(), ["checkWalletInvariants", "findOrphanedReservations"]);
});

test("ledger-settlement and ledger-evidence expose exactly the reviewed API (S6; nothing resolves a hold, grants, or reads vendor cost)", () => {
  assert.deepEqual(Object.keys(ledgerSettlement).sort(), ["holdReservation", "settleReservation"]);
  assert.deepEqual(Object.keys(ledgerEvidence).sort(), ["recordVendorCostEvidence"]);
});

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
test("S6 vendor-cost isolation (static): only ledger-evidence.ts writes or reads vendor_cost_evidence, and it touches no other ledger table", () => {
  for (const file of dbSrcFiles()) {
    const code = stripComments(readFileSync(join(root, "packages/db/src", file), "utf8"));
    if (file === "ledger-evidence.ts") {
      assert.match(code, /INSERT\s+INTO\s+\$\{S\}\.vendor_cost_evidence\b/, "ledger-evidence.ts itself inserts the evidence");
      assert.doesNotMatch(code, /\b(wallets|ledger_entries|credit_reservations|ledger_commands|ledger_authorizations|ledger_packages|ledger_quotes|promo_claims)\b/, "evidence code never names another ledger table");
      assert.doesNotMatch(code, /runLedgerCommand|FOR\s+UPDATE|\bBEGIN\b|UPDATE\s|DELETE\s/i, "evidence code takes no wallet lock, opens no command and never updates or deletes");
      continue;
    }
    // S8: the read-only checker names the table exactly once, in its trigger manifest (it verifies the append-only guards exist), and never selects from it.
    assert.doesNotMatch(file === "ledger-invariants.ts" ? code.replace('...immutable("vendor_cost_evidence"),', "") : code, /vendor_cost/i, `${file} never touches vendor-cost evidence`);
  }
});

test("S6: settle and hold entries are written only by ledger-settlement.ts, and no TypeScript names reconciliation_hold as a source state", () => {
  for (const file of dbSrcFiles()) {
    const code = stripComments(readFileSync(join(root, "packages/db/src", file), "utf8"));
    // S8: ledger-invariants.ts is the one READ-ONLY module that must NAME these states and entry kinds (D14: held bucket and hold-state orphans).
    // It is exempt from the two patterns below only because it is proven write-free by the next test; every other file is unchanged.
    if (file === "ledger-invariants.ts") continue;
    if (file !== "ledger-settlement.ts") assert.doesNotMatch(code, /'(settle|hold)'\s*,/, `${file} writes no settle or hold entry`);
    assert.doesNotMatch(code, /reconciliation_hold/, `${file}: no code path reads or leaves reconciliation_hold (W1 has no remedy; the database guard has no edge out)`);
  }
  for (const key of Object.keys(ledgerSettlement)) assert.doesNotMatch(key, /resolve|unhold|remedy|refund|release/i, key);
});

test("S8: ledger-invariants.ts is write-free (static): no DML, DDL, lock, advisory lock or command, and every SQL statement starts with SELECT or WITH", () => {
  const code = stripComments(readFileSync(join(root, "packages/db/src/ledger-invariants.ts"), "utf8"));
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REINDEX|REFRESH|CALL|DO|LISTEN|NOTIFY|DISCARD|RESET|SET\s+(LOCAL|SESSION|ROLE)|COMMIT)\b(?=\s+[A-Za-z_"'(])(?!\s+(?:of|from)\b)/, "no write verb followed by an operand");
  assert.doesNotMatch(code, /FOR\s+(UPDATE|SHARE|NO\s+KEY)|pg_advisory|pg_sleep|set_config\('(?:role|session_authorization|session_replication_role|default_transaction_read_only|transaction_read_only)|runLedgerCommand|appendGrantEntry|idempotency_key|workflow_ref\s*(?:=|,)/i);
  const direct = [...code.matchAll(/\.query\(\s*"([^"]*)"/g)].map(m => m[1]!.trim());
  for (const statement of direct) assert.match(statement, /^(SELECT |BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|ROLLBACK$)/, statement.slice(0, 60));
  const templates = [...code.matchAll(/`([^`]*)`/g)].map(m => m[1]!.trim()).filter(t => /\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(t));
  assert.ok(templates.length >= 12 && direct.length >= 3, "scanner found the statements");
  for (const statement of templates) assert.match(statement, /^(SELECT|WITH)\b/, statement.slice(0, 60));
  assert.match(code, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  for (const key of Object.keys(ledgerInvariants)) assert.doesNotMatch(key, /repair|fix|release|resolve|settle|hold|grant|write|mutate/i, key);
});

// ADR-0021 S3 addendum A4: BINDING for every future step. All command kinds implemented anywhere under packages/db/src.
const KNOWN_LEDGER_COMMAND_KINDS = ["grant_credits", "quote_issue", "quote_renew", "promo_claim", "promo_outcome", "reservation_authorize", "reservation_dispatch", "reservation_release", "reservation_settle", "reservation_hold",
  "refinement_skip", "refinement_restore", "refinement_pending", "refinement_unknown", "refinement_consume", "bundle_record_delivery", "bundle_open_refinements", "bundle_begin_closure", "bundle_close", "bundle_reopen"];
const dbSrcFiles = () => readdirSync(join(root, "packages/db/src")).filter(f => f.endsWith(".ts"));

test("ledger-promo exposes exactly the reviewed API (S4; a new export must be added here deliberately)", () => {
  assert.deepEqual(Object.keys(ledgerPromo).sort(), ["claimPromo", "getPromoClaim", "markPromoOutcome"]);
});

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

test("A4(3) for S5: INSERT INTO the authorization, package and reservation tables, and any UPDATE of reservations, appear only in ledger-reservations.ts", () => {
  const insert = /INSERT\s+INTO\s+\S*(?:ledger_authorizations|ledger_packages|credit_reservations)\b/i, update = /UPDATE\s+\S*credit_reservations\b/i;
  for (const file of dbSrcFiles()) {
    const text = readFileSync(join(root, "packages/db/src", file), "utf8");
    if (file === "ledger-reservations.ts") {
      assert.match(text, insert, "ledger-reservations.ts should itself insert into the S5 tables");
      // Its only UPDATE writes the dispatch marker; state is written by the 0005 definer function, never from TypeScript.
      assert.deepEqual([...text.matchAll(/UPDATE\s+\S*credit_reservations\s+SET\s+(\w+)/gi)].map(m => m[1]), ["workflow_ref"]);
      assert.doesNotMatch(text, /SET\s+state\b/i, "no TypeScript writes a reservation state");
      continue;
    }
    assert.doesNotMatch(text, insert, file); assert.doesNotMatch(text, update, file);
  }
});

test("A4(3) for S7: INSERT INTO the package-event and slot-event tables appears only in ledger-entitlements.ts, and no TypeScript anywhere updates a package or slot", () => {
  const insert = /INSERT\s+INTO\s+\S*(?:ledger_package_events|refinement_slot_events|refinement_slots)\b/i, update = /UPDATE\s+\S*(?:ledger_packages|refinement_slots|ledger_package_events|refinement_slot_events)\b/i;
  for (const file of dbSrcFiles()) {
    const text = readFileSync(join(root, "packages/db/src", file), "utf8");
    if (file === "ledger-entitlements.ts") {
      assert.deepEqual([...text.matchAll(/INSERT\s+INTO\s+\S*?(ledger_package_events|refinement_slot_events|refinement_slots)\b/gi)].map(m => m[1]), ["refinement_slot_events", "ledger_package_events"], "only the two insert-only event tables are written; state and the slot rows are written by the 0007 definers");
      continue;
    }
    assert.doesNotMatch(text, insert, file);
  }
  for (const file of dbSrcFiles()) assert.doesNotMatch(readFileSync(join(root, "packages/db/src", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), update, `${file} writes no package or slot state`);
  const entitlements = readFileSync(join(root, "packages/db/src/ledger-entitlements.ts"), "utf8");
  assert.doesNotMatch(entitlements, /(INSERT\s+INTO|UPDATE)\s+\S*(ledger_entries|wallets|credit_reservations)\b|appendGrantEntry/i, "refinements and package transitions write no ledger entry, no wallet bucket and no reservation");
});

test("A4(1): every ledger command locks the wallet row FOR UPDATE before touching any other ledger table",{ skip: ledgerTarget.skip }, async () => {
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

    // S5 commands: authorize (customer), dispatch and release (system) all take the wallet lock first.
    await grantSyntheticCredits(spyDb, { userId: user, grantSourceId: source, sourceRef: "lock-order-funds", units: 100 });
    const quoteVersionId = await issueTestQuote(spyDb, user, "final", "lock-order-final");
    let bundleReservations: Awaited<ReturnType<typeof authorizeQuote>>["reservations"] = [];
    const originalPackageId = await bundlePackage();
    log.length = 0;
    const authorized = await authorizeQuote(spyDb, { userId: user, quoteVersionId, idempotencyKey: "lock-order-authorize-0001", consent: consent(), originalPackageId, now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "reservation_authorize");
    const reservation = authorized.reservations[0]!;
    log.length = 0;
    await recordWorkflowRef(spyDb, { userId: user, component: "lock-order", reservationId: reservation.reservationId, workflowRef: "wf/lock-order-1", idempotencyKey: "lock-order-dispatch-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "reservation_dispatch");
    log.length = 0;
    await releaseReservation(spyDb, { userId: user, component: "lock-order", reservationId: reservation.reservationId, evidence: releaseEvidence(reservation.operationId), idempotencyKey: "lock-order-release-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "reservation_release");

    // S6 commands: settle and hold (system) take the wallet lock first, on two dispatched bundle reservations.
    const [toSettle, toHold] = bundleReservations;
    for (const [i, r] of [toSettle!, toHold!].entries()) await recordWorkflowRef(spyDb, { userId: user, component: "lock-order", reservationId: r.reservationId, workflowRef: `wf/lock-order-s6-${i}`, idempotencyKey: `lock-order-s6-dispatch-${i}` });
    log.length = 0;
    await settleReservation(spyDb, { userId: user, component: "lock-order", reservationId: toSettle!.reservationId, evidence: { transition: "settle", operationId: toSettle!.operationId, evidenceKind: "persisted_delivered", evidenceRef: "lock-order-settle", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }, idempotencyKey: "lock-order-settle-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "reservation_settle");
    log.length = 0;
    await holdReservation(spyDb, { userId: user, component: "lock-order", reservationId: toHold!.reservationId, evidence: { transition: "hold", operationId: toHold!.operationId, evidenceKind: "outcome_unknown", evidenceRef: "lock-order-hold", reason: "outcome_unknown" }, idempotencyKey: "lock-order-hold-0001" });
    assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "reservation_hold");

    async function bundlePackage() {
      const bundle = await issueTestQuote(spyDb, user, "bundle", "lock-order-bundle");
      const authorizedBundle = await authorizeQuote(spyDb, { userId: user, quoteVersionId: bundle, idempotencyKey: "lock-order-bundle-auth-01", consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      bundleReservations = authorizedBundle.reservations;
      return authorizedBundle.packageId!;
    }
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
