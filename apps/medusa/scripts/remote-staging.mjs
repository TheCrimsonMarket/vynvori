import fs from "node:fs/promises";

export const target = Object.freeze({ project: "lucky-little-devil", region: "us-east1",
  service: "vynvori-medusa-staging", account: "vynvori-medusa-runtime@lucky-little-devil.iam.gserviceaccount.com",
  registry: "us-east1-docker.pkg.dev/lucky-little-devil/vynvori-staging-images/medusa" });
const check = (ok, code) => { if (!ok) throw new Error(code); };
export async function bundledPolicy() {
  return JSON.parse(await fs.readFile(new URL("./remote-staging-policy.json", import.meta.url), "utf8"));
}
export function validateApproval(policy, now = new Date()) {
  check(policy?.id === "m2-private-synthetic-staging-v1" && policy.scope === "private-synthetic-staging-only" &&
    policy.approved === true && typeof policy.approvedBy === "string" && policy.approvedBy.trim().length > 0 &&
    /^[a-f0-9]{40}$/.test(policy.sourceCommit ?? ""), "REMOTE_APPROVAL_REQUIRED");
  const start = Date.parse(policy.notBefore), end = Date.parse(policy.expiresAt);
  check(Number.isFinite(+now) && Number.isFinite(start) && Number.isFinite(end) &&
    end <= Date.parse("2026-10-24T23:59:59Z") && start < end && +now >= start && +now < end, "REMOTE_APPROVAL_EXPIRED_OR_INVALID");
}
export function validateRemoteContext(env, mode, policy, now) {
  validateApproval(policy, now);
  check(mode === "serve" && env.K_SERVICE === target.service && Boolean(env.K_REVISION) &&
    env.K_CONFIGURATION === target.service && env.M2_ENV === "staging" && env.NODE_ENV === "production" &&
    env.M2_REMOTE_STAGING_APPROVAL === policy.id && env.M2_REMOTE_SOURCE_COMMIT === policy.sourceCommit &&
    !env.CLOUD_RUN_JOB && !env.CLOUD_RUN_EXECUTION && !env.VERCEL && !env.VERCEL_ENV &&
    !env.M2_AUTHORIZE_MEDUSA_MIGRATION, "REMOTE_CONTEXT_REJECTED");
  for (const [key, value] of Object.entries(env)) {
    check(!(key.startsWith("VYNVORI_") && value !== undefined && value !== "false") &&
      !key.startsWith("NEXT_PUBLIC_M2_") && !/REDIS/i.test(key), "REMOTE_FEATURE_OR_REDIS_REJECTED");
  }
  check(!env.NODE_TLS_REJECT_UNAUTHORIZED || env.NODE_TLS_REJECT_UNAUTHORIZED === "1", "TLS_OVERRIDE_REJECTED");
}
// Fixed metadata endpoints only; no token retrieval, credential files or IAM API grants.
export async function verifyMetadata(fetcher = fetch) {
  async function read(path) {
    const response = await fetcher(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
      headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(2000),
    });
    check(response.ok && response.headers.get("Metadata-Flavor") === "Google", "REMOTE_METADATA_UNAVAILABLE");
    return (await response.text()).trim();
  }
  const [project, region, account] = await Promise.all([
    read("project/project-id"), read("instance/region"), read("instance/service-accounts/default/email"),
  ]);
  check(project === target.project && /^projects\/\d+\/regions\/us-east1$/.test(region) && account === target.account,
    "REMOTE_IDENTITY_REJECTED");
}
export async function authorizeExecution(env, mode) {
  const remote = env.K_SERVICE || env.CLOUD_RUN_JOB || env.CLOUD_RUN_EXECUTION || env.VERCEL || env.VERCEL_ENV;
  if (!remote) {
    const operatorMigration = mode === "migrate" && env.M2_AUTHORIZE_MEDUSA_MIGRATION === "vynvori_medusa_staging";
    check((env.M2_ENV !== "staging" || operatorMigration) && !env.M2_REMOTE_STAGING_APPROVAL && !env.M2_REMOTE_SOURCE_COMMIT,
      "UNCONTROLLED_REMOTE_CONTEXT");
    return;
  }
  validateRemoteContext(env, mode, await bundledPolicy());
  await verifyMetadata();
}
