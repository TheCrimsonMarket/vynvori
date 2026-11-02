// Preview only: explicit Git path/hash allowlist. Never stages, commits, pushes or changes approval policies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const split = value => value.split("\0").filter(Boolean), sha = value => createHash("sha256").update(value).digest("hex");
const base = git(["rev-parse", "HEAD"]).trim(); assert.equal(base, "262489d8a5c367e579839806d7e8554a394dcd2a");
const tracked = new Set(split(git(["ls-files", "-z"]))), modified = split(git(["ls-files", "--modified", "-z"]));
const sources = split(git(["ls-files", "--others", "--exclude-standard", "-z", "--", "apps", "packages", "scripts"]));
const files = new Set([...modified.filter(file => file !== "docs/implementation/MILESTONE-PROGRESS.md"), ...sources]);
const docs = (await readdir(path.join(root, "docs/implementation"))).filter(name => /^ADR-001[0-5]-.*\.md$/.test(name));
for (const name of [...docs, "M1b-Local-Validation-Review-20261019.md", "M1b-Vynvori-Bridge-Execution-20261019.md", "M1b-Security-Source-Review-20261019.md"])
  files.add("docs/implementation/" + name);
files.add("docs/implementation/artifacts/M1b-Identity-Runtime-Grants-Proposal-20261019.sql");
files.add("docs/implementation/evidence/M1b-Deployment-Readiness-20261019.json");
files.add("docs/implementation/evidence/M1b-Connected-Revoked-Account-Mobile-20261019.png");
const queue = [...files].filter(file => file.endsWith(".md"));
for (let index = 0; index < queue.length; index++) {
  const file = queue[index], text = await readFile(path.join(root, file), "utf8");
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1].split("#")[0]; if (!href || /^(?:[a-z]+:|\/)/i.test(href)) continue;
    const relative = path.relative(root, path.resolve(root, path.dirname(file), href)).split(path.sep).join("/");
    assert.ok(!relative.startsWith("../")); await access(path.join(root, relative));
    if (!tracked.has(relative) && !files.has(relative)) {
      assert.match(relative, /^docs\/implementation\/(?:M1b-|ADR-001|evidence\/M1b-|artifacts\/M1b-)/);
      files.add(relative); if (relative.endsWith(".md")) queue.push(relative);
    }
  }
}
const records = [];
for (const file of [...files].sort()) {
  assert.ok(!file.split("/").some(part => part.startsWith(".env") || ["node_modules", ".git", ".next"].includes(part)));
  const bytes = await readFile(path.join(root, file)), text = bytes.toString("utf8"), isText = !bytes.includes(0) && Buffer.from(text).equals(bytes);
  if (isText) assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text), "Possible credential in candidate " + file);
  records.push({ path: file, status: tracked.has(file) ? "modified" : "new", bytes: bytes.length, sha256: sha(isText ? text.replaceAll("\r\n", "\n") : bytes), rawSha256: sha(bytes) });
}
const sourceDigest = sha(JSON.stringify(records.map(({ path, sha256 }) => ({ path, sha256 }))));
const result = { date: "2026-10-19", status: "PROPOSED_SOURCE_ONLY_PUBLICATION_REQUIRES_OWNER_APPROVAL", base, branch: "codex/m1b-central-identity", target: "main", draft: true,
  digestConvention: "SHA256 of sorted path+sha256 JSON; text LF-normalized, binary unchanged", sourceDigest, fileCount: records.length, files: records,
  excluded: ["docs/implementation/MILESTONE-PROGRESS.md", "unselected central/legacy inventory/proposal artifacts", "ignored outputs/private build logs/.env/backups", "this local allowlist/dossier"],
  policyActivation: false, merge: false, registration: false, deployment: false };
await writeFile(path.join(root, "docs/implementation/artifacts/M1b-Source-Publication-Allowlist-20261019.json"), JSON.stringify(result, null, 2) + "\n");
const proposal = `# VYNVORI M1b source-only publication proposal\n\nPrepared2026-10-19 against HEAD ${base}. This local approval dossier and its allowlist are not themselves staged.\n\nPublish ${records.length} explicitly listed files on branch \`codex/m1b-central-identity\`, opening a draft PR to \`main\`. Source digest: \`${sourceDigest}\`. [Exact path/hash allowlist](artifacts/M1b-Source-Publication-Allowlist-20261019.json).\n\nThe candidate implements disabled-by-default centralized SSO, durable encrypted sessions/PKCE, dedicated native Medusa mapping and owned reads, guest ownership, bounded revocation, and explicit identity migration/inspection tooling. [Code/evidence review](M1b-Local-Validation-Review-20261019.md), [security/source review](M1b-Security-Source-Review-20261019.md). Current deployment readiness verifies the normal npm/Next build and excludes backend/migration/test artifacts.\n\nRequested authorization covers commit/push/draft PR publication and source-only follow-up fixes in that draft for review. It does not approve source acceptance/merge, dependency-risk exceptions or policy activation, release tags/images, registration, live schema/grants/configuration, domains or deployment. Full CI remains blocked by the unchanged M2 source/lock approval seal.\n\nBefore committing, recheck HEAD, every exact path/hash, secrets and the staged path list. Use only this allowlist; never git add -A. Preserve all excluded work. Any changed candidate path needs review before publication.\n\nWhy confirmation is required: earlier Git publication approval named Portal#137/Core#138. The [repository instructions](../../AGENTS.md) separately require authorization for commits and pushes; this VYNVORI batch has not been authorized.\n`;
await writeFile(path.join(root, "docs/implementation/M1b-Source-Publication-Proposal-20261019.md"), proposal);
console.log(JSON.stringify({ status: result.status, fileCount: result.fileCount, sourceDigest, base }));
