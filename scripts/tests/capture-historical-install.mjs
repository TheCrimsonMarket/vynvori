// TEST ONLY, run by hand: records the third-party manifests that the historical M2 policy test needs, read from a
// real `npm ci --ignore-scripts` of the PR4 baseline lockfile. ADR-0024: after Medusa 2.23.1 the live install no
// longer holds that tree, so the historical evaluator regression reads this capture instead of the live install.
// Usage: node scripts/tests/capture-historical-install.mjs <directory holding a clean install of the baseline lock>
import fs from "node:fs/promises";
import path from "node:path";
import { ancestry, sha256 } from "../security/audit-policy.mjs";
import { REVIEWED_BASELINE } from "./reviewed-security-baseline.mjs";

const install = path.resolve(process.argv[2] ?? "");
const policy = JSON.parse(await fs.readFile(new URL("../../security/m2-exception-policy.json", import.meta.url), "utf8"));
const lockBytes = await fs.readFile(path.join(install, "package-lock.json"));
if (sha256(lockBytes) !== policy.fingerprint.lockSha256) throw new Error("HISTORICAL_LOCK_MISMATCH");
const lock = JSON.parse(lockBytes);
const targets = policy.exceptions.flatMap(exception => exception.nodes);
const locations = [...new Set([...targets, ...ancestry(lock, targets).flatMap(edge => [edge.parent, edge.child])])]
  .filter(location => location.startsWith("node_modules/")).sort();
const manifests = {};
for (const location of locations) {
  // Every location must be a real directory of the install, never a link.
  if (await fs.realpath(path.join(install, location)) !== path.join(await fs.realpath(install), location)) throw new Error("HISTORICAL_NODE_LINKED");
  const manifest = JSON.parse(await fs.readFile(path.join(install, location, "package.json"), "utf8"));
  if (manifest.version !== lock.packages[location]?.version) throw new Error("HISTORICAL_INSTALL_DIFFERS_FROM_LOCK");
  manifests[location] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {} };
}
const capture = { schemaVersion: 1, baseline: REVIEWED_BASELINE, lockSha256: policy.fingerprint.lockSha256,
  source: "npm ci --ignore-scripts of the baseline package-lock.json and workspace manifests", node: process.version, manifests };
process.stdout.write(JSON.stringify(capture, null, 1) + "\n");
