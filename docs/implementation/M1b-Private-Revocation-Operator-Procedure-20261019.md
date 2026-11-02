# M1b private revocation operator procedure

2026-10-19. Prepared procedure only. Live invocation, grants, configuration, monitoring enrollment and scheduling remain NOT_AUTHORIZED and NOT_RUN. The CI-only dependency exception grants none of these permissions.

## Preconditions and custody

Use a verified checkout of the approved staging revision, its existing locked dependencies and the separately approved staging configuration. The operator must establish the exact issuer, assigned central client, isolated preview project and scoped creative database before invocation. The actual client ID and isolated project are still unassigned. Do not substitute the public Vercel project or root `DATABASE_URL`.

The approved private configuration must be injected from its normal secret custody without printing/exporting it into evidence. The runtime validates the same isolated staging bindings as the web app; copying metadata values into an operator process is configuration, not proof of a Vercel deployment or Cloud Run IAM. Live execution needs separate owner authorization and an authenticated operator environment. Do not add a public reconciliation route or bypass the enrollment checks to make the command run.

Retain encryption key versions needed by pending sessions. Central client credentials, application encryption keys, bridge proof keys and Medusa signing keys are distinct. The queue uses the retained central refresh token only for the fixed authenticated revoke operation; it never requests a replacement refresh token.

## One explicit batch

After the preconditions and separate authorization are satisfied, run from the verified repository root in the approved private operator environment. This example invokes the existing runtime method once and closes its database pool. It creates no scheduler or HTTP endpoint. It can revoke up to five eligible central families, so it is not a read-only diagnostic.

```powershell
@'
import { createIdentityRuntime } from "./apps/web/src/server/auth-runtime.ts";
let runtime;
try {
  runtime = createIdentityRuntime(process.env);
  if (!runtime.enabled || !runtime.reconcileRevocations) throw new Error();
  const counts = await runtime.reconcileRevocations(5);
  console.log(JSON.stringify({ operation: "central-revocation-batch", ...counts }));
} catch {
  console.error("Central revocation batch unavailable; inspect privately before another invocation.");
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
}
'@ | node --conditions=react-server --import tsx --input-type=module
```

Record the approved source revision, UTC execution time and four returned counts only: `attempted`, `confirmed`, `pending`, `manualReview`. Do not record tokens, ciphertext, keys, email, subjects, connection strings or complete environment output. A successful process exit does not mean every eligible revocation was confirmed: inspect the counts and backlog.

Claims are cohort scoped and close local access before network I/O. A claim consumes one of eight attempts. Backoff is one minute doubling to one hour; a crash also consumes an attempt. A batch stops on a lost local acknowledgement. Do not immediately rerun in a loop after failure or uncertainty. Recheck the private backlog and current lease before a later explicitly approved invocation. A definite authority success and committed local acknowledgement are both required for confirmation.

## Backlog monitoring and escalation

Monitor aggregate counts scoped to the approved issuer/client/deployment, using an already authorized read-only database session. Include pending rows with eight attempts, due rows, active leases and the earliest next-attempt time. The batch's `manualReview` count describes only rows claimed by that invocation; it does **not** count already exhausted rows. Historical sessions with missing cohort metadata require a separate aggregate and manual investigation and must not be assigned to a client by assumption.

Proposed staging operating cadence for owner review: a single batch per minute while synthetic acceptance is actively supervised; alert immediately on any exhausted row, malformed/decryption failure, absent required key version, lost acknowledgement or unexpected authority failure. Alert when a due eligible backlog persists for five minutes. These are proposed operator thresholds, not an enrolled scheduler or implemented alert service. If demand exceeds five claims per minute, stop expansion and review capacity rather than increasing the hard batch limit silently.

For exhaustion or uncertainty, keep local sessions revoked. Privately compare the exact cohort, family expiry, retained key version, central deployment revision and authority health. Preserve lease/attempt evidence. Do not reset attempts, reopen sessions, relink identities, expose retained credentials, retry a refresh, recreate a customer or infer central revocation from local cookie removal. If authority state cannot be established, report it as unconfirmed; request a separately reviewed identity-owner recovery action.

On rollback, stop further invocation and disable the enrolled identity surface according to the approved rollout plan. Retain additive tables, cohort/lease history and required key versions for reconciliation. Application rollback is not authorization to delete rows or restore an entire shared database.

## Service identity and executed evidence

Central revocation does not call Medusa and therefore does not require the short-lived Medusa service identity. Commerce operations do. The current staging adapter accepts a privately supplied short-lived service ID token, checks destination audience and expiry, and relies on Cloud Run for signature/IAM validation. The token is captured in the runtime configuration and is not automatically renewed; replacement requires a reviewed configuration/runtime refresh. It must remain valid through the synthetic acceptance window. Missing or expired input fails closed.

Automatic renewable federation, its IAM binding, private token custody, actual expiry/replacement checks and the deployed Cloud Run denial tests remain operational gates. Do not claim the manually supplied token is a renewable production identity solution.

Executed locally: importing `createIdentityRuntime` through the exact Node/tsx command with empty configuration returned `enabled: false`, no reconciliation method and no database connection. Existing seven synthetic reconciliation unit cases and disposable PostgreSQL concurrency/backoff/lease tests are recorded in [ADR 0015](ADR-0015-M1b-Bounded-Revocation-Reconciliation.md). Enabled operator execution against the real authority, actual backlog monitoring and exhausted-row recovery remain NOT_RUN.
