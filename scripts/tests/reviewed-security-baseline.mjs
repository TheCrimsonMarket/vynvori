// TEST ONLY: compute historical source hashes from immutable Git objects.
// Production run-audit imports neither this helper nor a supplied source fixture.
import { execFileSync } from "node:child_process";
import { sha256, snapshot } from "../security/audit-policy.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export const REVIEWED_BASELINE = "259d3883f9d346cbfd117b014beb6bc5d9b18a72";
export function reviewedSurface(root, policy) {
  const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", REVIEWED_BASELINE, "--", ...policy.fingerprint.securityRoots], { cwd: root, encoding: "utf8" });
  const files = tree.trim().split("\n").filter(Boolean);
  const objects = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: files.map(file => `${REVIEWED_BASELINE}:${file}\n`).join(""), maxBuffer: 16 * 1024 * 1024 });
  let position = 0;
  const surface = {};
  for (const file of files) {
    const end = objects.indexOf(10, position);
    const [, type, size] = objects.subarray(position, end).toString().split(" ");
    if (type !== "blob" || !/^\d+$/.test(size)) throw new Error("BASELINE_GIT_OBJECT_INVALID");
    const bytes = objects.subarray(end + 1, end + 1 + Number(size));
    position = end + 2 + Number(size);
    let content = /\.(?:ts|tsx|mjs|json|yml|yaml|css|md|sql)$/.test(file) || file.endsWith(".env.example") ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes;
    if (file === "scripts/security/audit-policy.mjs") content = content.replace(/export const APPROVED_POLICY_SHA256 = "[^"]+";/, 'export const APPROVED_POLICY_SHA256 = "REVIEWED_ANCHOR";');
    surface[file] = sha256(content);
  }
  return surface;
}

/** TEST ONLY: immutable local source/manifests with the captured third-party install of the same baseline lockfile.
 * This is a historical evaluator regression input, never approval of the current workspace. */
export async function historicalState(root, policy) {
  const inventory = execFileSync("git", ["ls-tree", "-r", "--name-only", REVIEWED_BASELINE], { cwd: root, encoding: "utf8" }).trim().split("\n");
  const files = inventory.filter(file => ["package-lock.json", ".npmrc", "npm-shrinkwrap.json", "design/reference/package.json"].includes(file) ||
    /^(?:apps|packages|services)\/[^/]+\/package\.json$/.test(file) || policy.fingerprint.securityRoots.some(prefix => file === prefix || file.startsWith(prefix + "/")));
  const objects = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: files.map(file => `${REVIEWED_BASELINE}:${file}\n`).join(""), maxBuffer: 32 * 1024 * 1024 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-historical-policy-"));
  let position = 0;
  try {
    for (const file of files) {
      const end = objects.indexOf(10, position), [, kind, length] = objects.subarray(position, end).toString().split(" ");
      if (kind !== "blob" || !/^\d+$/.test(length)) throw new Error("BASELINE_GIT_OBJECT_INVALID");
      const bytes = objects.subarray(end + 1, end + 1 + Number(length)); position = end + 2 + Number(length);
      const target = path.resolve(temporary, file);
      if (!target.startsWith(temporary + path.sep)) throw new Error("BASELINE_PATH_INVALID");
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
    if (sha256(await fs.readFile(path.join(temporary, "package-lock.json"))) !== policy.fingerprint.lockSha256) throw new Error("HISTORICAL_LOCK_MISMATCH");
    // Third-party manifests come from a capture of a real `npm ci` of this baseline lockfile (ADR-0024), never from
    // the approval policy. Medusa 2.23.1 replaced the live tree, so the live install can no longer stand in for it.
    const capture = JSON.parse(await fs.readFile(new URL("../../security/fixtures/m2-historical-install.json", import.meta.url), "utf8"));
    if (capture.schemaVersion !== 1 || capture.baseline !== REVIEWED_BASELINE || capture.lockSha256 !== policy.fingerprint.lockSha256) throw new Error("HISTORICAL_INSTALL_CAPTURE_MISMATCH");
    for (const [location, manifest] of Object.entries(capture.manifests)) {
      if (!location.startsWith("node_modules/") || location.split("/").includes("..") || location.includes("\\") || path.posix.isAbsolute(location)) throw new Error("BASELINE_PATH_INVALID");
      const target = path.resolve(temporary, location, "package.json");
      if (!target.startsWith(temporary + path.sep)) throw new Error("BASELINE_PATH_INVALID");
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(manifest));
    }
    const state = await snapshot(temporary, policy);
    return state;
  } finally {
    // The temporary tree holds only files written above; it links nothing into the live install.
    const absolute = await fs.realpath(temporary), tempParent = await fs.realpath(os.tmpdir());
    if (path.dirname(absolute) !== tempParent || !path.basename(absolute).startsWith("VYNVORI-historical-policy-")) throw new Error("BASELINE_CLEANUP_TARGET_INVALID");
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
