# M1b strict central contact response

2026-10-18, Asia/Dhaka. **LOCAL CANDIDATE v9 ONLY. Registration and deployment BLOCKED; VYNVORI bridge NOT_IMPLEMENTED.** The founder approved central `profile email` for the dedicated staging client. This additive contract applies only to explicitly enrolled strict clients. Legacy userinfo, grants, token issuance, refresh and revoke contracts are unchanged.

## API and authority

Candidate-only `POST /mana/oauth/strict/v1/profile` (also `/oauth/strict/v1/profile`) uses the existing strict server transport: authenticated client Basic credentials, form body containing only `token`, bounded parser, per-client rate enforcement, no browser Origin/Cookie, and no-store responses. No live endpoint or client registration is implied.

The access token must have both consented `profile` and `email` scopes. Registration permission alone does not grant disclosure. Verification pins issuer, audience, client, signature/type/time, persisted current family/access hash, current client grants/scopes and current central subject token version. After contact I/O it repeats that verification before returning contact fields. Missing adapters/storage fail closed with sanitized unavailable responses; no cache or provider fallback exists.

The lazy adapter selects only central `userBN` fields `_id email emailVerified displayName` by the already verified subject. Top-level `emailVerified` is returned as true only when literally true. Linked-provider email/verification fields are not substituted. The existing model declares these fields; no user-model migration or customer data mutation was added.

Synthetic response example:

```json
{
  "iss": "https://dev.portal.raum.au",
  "sub": "507f1f77bcf86cd799439011",
  "client_id": "synthetic-client-not-a-registration",
  "aud": "urn:vynvori:staging",
  "email": "synthetic@example.invalid",
  "email_verified": false,
  "name": "Synthetic"
}
```

The name is optional and bounded. Email must be usable contact text with a maximum 254 characters and no whitespace/control characters; missing or malformed email produces `409 contact_required`. No placeholder is synthesized. `403 insufficient_scope` discloses no profile; invalid client/token and storage failures return 401/503 respectively. Arbitrary roles/private adapter fields, raw errors and credentials are omitted.

## Identity, commerce and rollout

Email/name remain mutable contact data. Only verified issuer + subject establishes identity. The new response does not authorize email-based account linking or a silent merge, create a Medusa customer, assert a verified mailbox when central state says otherwise, or grant staff privileges. Future Medusa provisioning must handle missing/conflicting email as explicit setup/conflict states, with fenced identity mappings and recovery; those workflows remain unimplemented.

No database migration/event was introduced. Rollback is to disable the strict cohort and deny its operations, preserving legacy consumers and strict-family lineage. Never fall back to legacy userinfo for a failed strict profile request. Do not prepare storage, register clients, distribute secrets or deploy from this document.

## Executed evidence and limits

Owner fresh `npm ci` passed in both isolated candidates with unchanged manifests/locks. Existing v8 checks were rerun before the contact extension. Ten new authority tests first failed on the absent contact method while the existing 25 authority assertions passed. The implemented extension adds 16 passing checks: scope versus registration, mutable/unverified/missing/invalid contact, wrong subject, secret/scope/revocation negatives, sanitized failures, server transport and actual Core/Portal/MongoDB source integration.

Final Portal full suite: 114 suites PASS / 30 FAIL; 748 assertions PASS / 19 FAIL. OAuth: 281/281 PASS in 24 suites. Core fresh full suite: 25 suites PASS / 2 FAIL; 176 assertions PASS / 22 FAIL. All baseline and prior candidate assertion identities/statuses/counts are preserved, including the same failure identities. Affected source/tests pass the existing ESLint configuration. These results demonstrate no new failures in the executed suites, not complete dependent-service compatibility or deployed acceptance.

See [fresh evidence](evidence/M1b-Fresh-Validation-20261018.json), [source hashes](evidence/M1b-Portal-Release-Candidate-20261018.json), [v9 review patch](artifacts/M1b-Portal-Candidate-v9-20261018.patch) and [current owner review](M1b-Central-Candidate-Review-20261018.md). The earlier v8 patch remains retained as historical evidence. All unexecuted staging and M1b acceptance gates remain open.
