import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { startProcess, stopProcess, waitProcess } from "../process-lifecycle.mjs";
import { configurationIdentity, scanIdentity } from "./pr5-local-policy.mjs";

export const TRIVY_IMAGE = "aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";
export async function command(args, { cwd, timeout = 180000 } = {}) {
  const handle = startProcess("docker", args, { cwd, env: process.env });
  let stdout = "", stderr = "";
  handle.child.stdout.on("data", bytes => { stdout += bytes; });
  handle.child.stderr.on("data", bytes => { stderr += bytes; });
  try { await waitProcess(handle, timeout, "Local security image check"); }
  finally { await stopProcess(handle); }
  return { stdout, stderr };
}
async function fileSha(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file);
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest("hex");
}

// No caller-supplied image, report, database cache or accepting/updating flag.
// The only outputs are external evidence and an owned ephemeral Docker image.
export async function verifyLocalImage(root, evidence, reviewedRuntime) {
  const tag = `vynvori-pr5-security:${randomBytes(10).toString("hex")}`;
  const scannerName = `vynvori-pr5-scan-${randomBytes(10).toString("hex")}`;
  const iid = path.join(evidence, "image-id.txt");
  let imageId, localEngine = false;
  try {
    const context = JSON.parse((await command(["context", "inspect"])).stdout)[0];
    const endpoint = process.env.DOCKER_HOST || context.Endpoints.docker.Host;
    if (!/^(?:unix|npipe):\/\//.test(endpoint)) throw new Error("REMOTE_DOCKER_ENGINE_FORBIDDEN");
    localEngine = true;
    const build = await command(["build", "--iidfile", iid, "-f", "apps/medusa/Dockerfile", "-t", tag, "."], { cwd: root, timeout: 600000 });
    await fs.writeFile(path.join(evidence, "container-build.log"), build.stdout + build.stderr);
    imageId = (await fs.readFile(iid, "utf8")).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("BUILT_IMAGE_ID_INVALID");
    const inspect = JSON.parse((await command(["image", "inspect", imageId])).stdout)[0];
    const code = await fs.readFile(path.join(root, "scripts/security/pr5-image-inventory.mjs"), "utf8");
    const inventoryResult = await command(["run", "--rm", "--network=none", "--entrypoint", "/usr/local/bin/node", imageId, "--input-type=module", "-e", code]);
    const inventory = JSON.parse(inventoryResult.stdout.trim());
    await fs.writeFile(path.join(evidence, "runtime-file-inventory.json"), JSON.stringify(inventory, null, 2));
    const archive = path.join(evidence, "reviewed-image.tar");
    await command(["save", "-o", archive, imageId], { timeout: 180000 });
    const archiveSha256 = await fileSha(archive);
    // Fresh vulnerability DB every run. A failed download/scan fails the gate;
    // there is no stale-cache fallback or severity/unfixed/VEX suppression.
    const scanResult = await command(["run", "--name", scannerName, "--label", `vynvori.security-check=${scannerName}`,
      "--mount", `type=bind,source=${evidence},target=/evidence`, TRIVY_IMAGE,
      "image", "--input", "/evidence/reviewed-image.tar", "--cache-dir", "/tmp/vynvori-pr5-db", "--scanners", "vuln", "--list-all-pkgs", "--format", "json", "--output", "/evidence/runtime-scan.json", "--quiet"], { timeout: 300000 });
    await fs.writeFile(path.join(evidence, "runtime-scan.log"), scanResult.stdout + scanResult.stderr);
    const report = JSON.parse(await fs.readFile(path.join(evidence, "runtime-scan.json"), "utf8"));
    await command(["cp", `${scannerName}:/tmp/vynvori-pr5-db/db/metadata.json`, path.join(evidence, "vulnerability-db-metadata.json")]);
    const database = JSON.parse(await fs.readFile(path.join(evidence, "vulnerability-db-metadata.json"), "utf8"));
    // Scanning a different archive/image cannot borrow this approval.
    const inspectedConfig = inspect.Descriptor?.mediaType?.includes("index") ? null : inspect.Id;
    if (inspectedConfig && report.Metadata.ImageID !== inspectedConfig) throw new Error("SCAN_IMAGE_ID_MISMATCH");
    const result = { imageId, archiveSha256, localEngineVerified: true, database, configuration: configurationIdentity(inspect.Config), inventory,
      baseLayers: inspect.RootFS.Layers.slice(0, reviewedRuntime.baseLayers.length), scan: scanIdentity(report) };
    await fs.writeFile(path.join(evidence, "runtime-evaluation-input.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    await fs.writeFile(path.join(evidence, "runtime-failure.txt"), error.message);
    throw error;
  } finally {
    // A timed-out scanner client may leave its container alive. Remove only its
    // exact owned name/label. Cleanup errors remain failures, not forced success.
    if (localEngine) {
      const found = await command(["ps", "-aq", "--filter", `label=vynvori.security-check=${scannerName}`]);
      for (const id of found.stdout.trim().split(/\s+/).filter(Boolean)) await command(["rm", "-f", id]);
      if (imageId) await command(["image", "rm", tag]);
    }
    // Keep JSON/hash/log evidence, not a private image archive in CI artifacts.
    await fs.rm(path.join(evidence, "reviewed-image.tar"), { force: true });
  }
}
