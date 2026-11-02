// Produces an UNAPPROVED review artifact. It never changes a policy, selector or deployment setting.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runAudit, safeEvidence } from "./run-audit.mjs";
import { verifyLocalImage } from "./pr5-runtime-check.mjs";
import { digest } from "./audit-policy.mjs";
import { collectM1bReviewState, m1bContext, m1bProposal } from "./m1b-source-policy.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url));
if (process.argv.length !== 2) throw new Error("REVIEW_ONLY_NO_ACCEPTING_FLAGS");
if (process.platform !== "linux") throw new Error("REVIEW_COLLECTION_REQUIRES_LINUX_CI");
m1bContext(process.env);
const base = path.resolve(process.env.RUNNER_TEMP || os.tmpdir()), relative = path.relative(root, base);
if (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("REVIEW_EVIDENCE_MUST_BE_EXTERNAL");
const output = await fs.mkdtemp(path.join(base, "VYNVORI-M1b-security-review-"));
try {
  const state = await collectM1bReviewState(root);
  const production = await runAudit(), all = await runAudit(false);
  if ([production, all].some(audit => audit.executionError || audit.signal || ![0, 1].includes(audit.exitCode))) throw new Error("AUDIT_EXECUTION_FAILED");
  const previousRuntime = JSON.parse(await fs.readFile(path.join(root, "security/fixtures/pr5-reviewed-runtime.json"), "utf8"));
  const image = await verifyLocalImage(root, output, previousRuntime);
  const after = await collectM1bReviewState(root);
  if (digest(state) !== digest(after)) throw new Error("SOURCE_CHANGED_DURING_REVIEW");
  const proposal = m1bProposal(state, production, all, image);
  const publication = path.join(output, "publish"); await fs.mkdir(publication);
  for (const [name, value] of [["proposal.json", JSON.stringify(proposal, null, 2)], ["production-audit.json", production.stdout], ["all-audit.json", all.stdout],
    ["runtime-scan.json", await fs.readFile(path.join(output, "runtime-scan.json"), "utf8")], ["runtime-input.json", JSON.stringify(image, null, 2)]]) {
    if (!safeEvidence(value, process.env)) throw new Error("UNSAFE_REVIEW_EVIDENCE");
    await fs.writeFile(path.join(publication, name), value + "\n");
  }
  console.log(JSON.stringify({ status: "PROPOSAL_ONLY_NOT_APPROVED", sourceCommit: state.commit, proposalDigest: digest(proposal), publication }));
} catch (error) { console.error("M1b review collection rejected: " + error.message); process.exitCode = 1; }
