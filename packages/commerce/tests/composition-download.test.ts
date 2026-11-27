/**
 * ADR-0022 C6 unit and static tests for download grants: the typed grant TTL (no default), and static proofs that the download
 * path is not coupled to payment, ledger, wallet or entitlement code, that only the service spends a grant, and that no token is
 * ever logged. The behavioural scenarios are in composition-download-suite.ts (in-memory and PostgreSQL).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_LIMIT_KEYS, parseCompositionLimits, resolveDownloadGrantTtlMs, SECONDS_STRUCTURAL_CEILING } from "../src/composition-limits";
import { syntheticLimitEnv } from "./composition-synthetic";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : []; });
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const ROUTES = "apps/web/src/app/api/v1/compositions/[id]/assets/[assetId]";

test("grant TTL: only from M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS, in milliseconds; unset, zero, negative, fractional or oversized closes minting", () => {
  assert.ok(COMPOSITION_LIMIT_KEYS.includes("M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS"));
  const env = (value: string | undefined) => ({ ...syntheticLimitEnv(), M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS: value });
  // SYNTHETIC value, not policy.
  assert.equal(resolveDownloadGrantTtlMs(parseCompositionLimits(env("37"))), 37_000);
  for (const value of [undefined, "", "0", "-5", "1.5", "07", "1e3", " 37", String(SECONDS_STRUCTURAL_CEILING + 1)]) {
    assert.equal(resolveDownloadGrantTtlMs(parseCompositionLimits(env(value))), undefined, String(value));
  }
  assert.equal(resolveDownloadGrantTtlMs(parseCompositionLimits({})), undefined, "no default");
});

test("static: the download path imports nothing from payment, ledger, wallet, entitlement or commerce-order code (doc 06: originals are never gated)", () => {
  const files = ["packages/commerce/src/composition.ts", "packages/commerce/src/composition-http.ts", `${ROUTES}/download-grants/route.ts`, `${ROUTES}/download/route.ts`];
  const forbidden = /ledger|entitlement|wallet|payment|credit|medusa|checkout|export-pack|reservation/i;
  for (const file of files) {
    const imports = [...read(file).matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)].map(m => m[1] ?? m[2] ?? m[3]!);
    assert.ok(imports.length > 0, file);
    for (const specifier of imports) assert.doesNotMatch(specifier, forbidden, `${file} imports ${specifier}`);
  }
});

test("static: only the service spends or mints a grant, and nothing on the download path logs", () => {
  const files = [...walk(join(repo, "packages/commerce/src")), ...walk(join(repo, "apps/web/src"))];
  const users = files.filter(file => /\b(consumeDownloadGrant|createDownloadGrant|validateDownloadGrant)\b/.test(readFileSync(file, "utf8"))).map(file => file.slice(repo.length + 1));
  assert.deepEqual(users, ["packages/commerce/src/composition.ts"], "the HTTP boundary and the web app never call the grant primitives directly");
  const service = read("packages/commerce/src/composition.ts");
  assert.equal(service.match(/store\.consumeDownloadGrant\(/g)?.length, 1, "one consuming call");
  // The consume comes after the byte fetch and verification in redeem (D4 steps 3 and 4).
  const redeem = service.slice(service.indexOf("async redeemDownloadGrant("));
  assert.ok(redeem.indexOf("storage.get(") > 0 && redeem.indexOf("storage.get(") < redeem.indexOf("store.consumeDownloadGrant("), "fetch and verify before consuming");
  for (const file of ["packages/commerce/src/composition.ts", "packages/commerce/src/composition-http.ts", `${ROUTES}/download-grants/route.ts`, `${ROUTES}/download/route.ts`]) {
    assert.doesNotMatch(read(file), /\bconsole\.|\blogger\b/, `${file} must not log (a token could reach a log)`);
  }
});

test("static: each new route file forwards exactly one method to the composition runtime", () => {
  const mint = read(`${ROUTES}/download-grants/route.ts`), download = read(`${ROUTES}/download/route.ts`);
  assert.match(mint, /export async function POST\(/); assert.doesNotMatch(mint, /export async function (GET|PUT|PATCH|DELETE)\(/);
  assert.match(mint, /invokeCompositionRoute\("mintDownloadGrant"/);
  assert.match(download, /export async function GET\(/); assert.doesNotMatch(download, /export async function (POST|PUT|PATCH|DELETE|HEAD)\(/);
  assert.match(download, /invokeCompositionRoute\("downloadAsset"/);
  for (const file of [mint, download]) assert.match(file, /export const dynamic = "force-dynamic"/);
});

test("static (founder decision 2026-11-27, logs never carry the link code): no token is ever placed in a URL", () => {
  const http = read("packages/commerce/src/composition-http.ts");
  assert.doesNotMatch(http, /\?grant=|grant=\$\{/, "the mint response builds no URL with a token");
  assert.match(http, /downloadUrl: `\/api\/v1\/compositions\/\$\{compositionId\}\/assets\/\$\{assetId\}\/download`, grantToken: token/);
  assert.match(http, /new URL\(request\.url\)\.search !== ""/, "redeem refuses any query string");
});
