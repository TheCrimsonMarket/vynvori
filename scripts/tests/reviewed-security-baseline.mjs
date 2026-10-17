// TEST ONLY: compute historical source hashes from immutable Git objects.
// Production run-audit imports neither this helper nor a supplied source fixture.
import { execFileSync } from "node:child_process";
import { sha256 } from "../security/audit-policy.mjs";
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
