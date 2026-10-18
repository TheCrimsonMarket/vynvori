import assert from "node:assert/strict";
import { test } from "node:test";
import { HashSha256Schema, IsoDateSchema, ProjectIdSchema } from "../src/ids";
import { PlanStateV1Schema } from "../src/studio-plan";
import { QuoteViewV3Schema } from "../src/quote";
import { PublicOperationV3Schema, RefinementSlotV1Schema } from "../src/operations";
import { StudioScreenV1Schema } from "../src/screens";
import { CompositionReviewProjectionV1Schema } from "../src/editor";
import { CustomerDigitalExportEntitlementV1Schema, DigitalExportEntitlementV1Schema, toCustomerDigitalExportEntitlement } from "../src/account-commerce";
import { StudioRecoveryProjectionV1Schema } from "../src/recovery";
import { availabilityFixture, conceptBundleQuoteFixture, promoSinglePreviewQuoteFixture, SYNTHETIC_HASH_A } from "./fixtures";

test("branded IDs and primitives reject malformed input", () => {
  assert.equal(ProjectIdSchema.parse("project-1"), "project-1");
  assert.throws(() => ProjectIdSchema.parse(""));
  assert.equal(HashSha256Schema.parse(SYNTHETIC_HASH_A), SYNTHETIC_HASH_A);
  assert.throws(() => HashSha256Schema.parse("not-a-hash"));
  assert.throws(() => HashSha256Schema.parse(SYNTHETIC_HASH_A.toUpperCase()));
  assert.doesNotThrow(() => IsoDateSchema.parse("2026-10-18T00:00:00.000Z"));
  assert.throws(() => IsoDateSchema.parse("not-a-date"));
});

test("PlanStateV1: unapproved/approved carry no concept slots, bundle_authorized needs exactly three distinct mapped slots", () => {
  assert.doesNotThrow(() => PlanStateV1Schema.parse({ kind: "unapproved", conceptSlots: [] }));
  const directions = [
    { directionId: "d1", title: "A", rationale: "r", visualIntent: "v", risks: [] },
    { directionId: "d2", title: "B", rationale: "r", visualIntent: "v", risks: [] },
    { directionId: "d3", title: "C", rationale: "r", visualIntent: "v", risks: [] },
  ];
  assert.doesNotThrow(() => PlanStateV1Schema.parse({ kind: "approved", planVersionId: "pv-1", approvalHash: "hash-1", directions, conceptSlots: [] }));
  // approved with non-empty slots is rejected — no schema branch allows it.
  assert.throws(() => PlanStateV1Schema.parse({ kind: "approved", planVersionId: "pv-1", approvalHash: "hash-1", directions, conceptSlots: [{}] }));

  const slot = (directionId: string) => ({ slotNumber: 1, directionId, status: "waiting", operationId: null, persistedVersionId: null, publicReceiptId: null });
  const validBundle = {
    kind: "bundle_authorized", planVersionId: "pv-1", approvalHash: "hash-1", directions,
    conceptSlots: [{ ...slot("d1"), slotNumber: 1 }, { ...slot("d2"), slotNumber: 2 }, { ...slot("d3"), slotNumber: 3 }],
  };
  assert.doesNotThrow(() => PlanStateV1Schema.parse(validBundle));

  const mismatchedBundle = { ...validBundle, conceptSlots: [{ ...slot("d1"), slotNumber: 1 }, { ...slot("d1"), slotNumber: 2 }, { ...slot("d3"), slotNumber: 3 }] };
  assert.throws(() => PlanStateV1Schema.parse(mismatchedBundle), /bijectively/);

  const foreignDirectionBundle = { ...validBundle, conceptSlots: [{ ...slot("d1"), slotNumber: 1 }, { ...slot("d2"), slotNumber: 2 }, { ...slot("unknown"), slotNumber: 3 }] };
  assert.throws(() => PlanStateV1Schema.parse(foreignDirectionBundle));

  assert.throws(() => PlanStateV1Schema.parse({ kind: "unapproved", conceptSlots: [], extraField: "nope" }));
});

test("QuoteViewV3: authorizationHint.quoteId must match quoteId, expiresAt must be after issuedAt", () => {
  assert.doesNotThrow(() => conceptBundleQuoteFixture());
  assert.throws(() => conceptBundleQuoteFixture({ authorizationHint: { quoteId: "different-quote", checkedAt: "2026-10-18T00:00:00.000Z", canAuthorize: true, reasonCodes: [], quoteVersionId: "qv-1" } }));
  assert.throws(() => conceptBundleQuoteFixture({ expiresAt: "2026-10-17T00:00:00.000Z" }));
});

test("QuoteViewV3: concept_bundle_3x2 requires three distinct directions and at least one eligible quoted use", () => {
  assert.throws(() => conceptBundleQuoteFixture({ directionIds: ["direction-1", "direction-1", "direction-2"] }));
  assert.throws(() => conceptBundleQuoteFixture({ downstreamEligibility: { ...conceptBundleQuoteFixture().downstreamEligibility, quotedEligibleUses: [] } }));
});

test("QuoteViewV3 rejects unknown fields at every trust boundary (strict parsing)", () => {
  const fixture = conceptBundleQuoteFixture();
  assert.throws(() => QuoteViewV3Schema.parse({ ...fixture, injectedField: "nope" }));
});

test("PublicOperationV3: a delivered operation must carry an authorized (non not_authorized) receipt", () => {
  assert.throws(() => PublicOperationV3Schema.parse({
    state: "delivered", operationId: "op-1", persistedVersionId: "v-1",
    receipt: { kind: "not_authorized" },
  }));
  assert.doesNotThrow(() => PublicOperationV3Schema.parse({
    state: "delivered", operationId: "op-1", persistedVersionId: "v-1",
    receipt: { kind: "settled", quoteId: "q-1", operationId: "op-1", receiptId: "r-1", heldUnits: 0, settledUnits: 10 },
  }));
});

test("RefinementSlotV1: each state carries exactly its required fields, nothing extra", () => {
  assert.doesNotThrow(() => RefinementSlotV1Schema.parse({ state: "available", ordinal: 1, packageId: "pkg-1", sourceVersionId: null }));
  assert.doesNotThrow(() => RefinementSlotV1Schema.parse({ state: "forfeited", ordinal: 2, packageId: "pkg-1", closureCause: "final_delivered" }));
  assert.throws(() => RefinementSlotV1Schema.parse({ state: "available", ordinal: 1, packageId: "pkg-1" })); // missing sourceVersionId
  assert.throws(() => RefinementSlotV1Schema.parse({ state: "forfeited", ordinal: 2, packageId: "pkg-1", closureCause: "final_delivered", sourceVersionId: "v-1" })); // extra field for this branch
});

test("StudioScreenV1: screenId and stage must agree with the canonical ST-xx mapping", () => {
  const base = {
    schemaVersion: "studio-screen.v1", route: "/studio", projectId: null, status: null,
    availableActions: [], errorCode: null, supportCases: [], history: [],
  };
  assert.doesNotThrow(() => StudioScreenV1Schema.parse({ ...base, screenId: "ST-00", stage: "entry", entryModes: ["guide_me", "create_freely"], byoLink: "/customize" }));
  assert.throws(() => StudioScreenV1Schema.parse({ ...base, screenId: "ST-00", stage: "guided_brief", entryModes: ["guide_me", "create_freely"], byoLink: "/customize" }));
});

test("ED-03 CompositionReviewProjectionV1: proof/validation/cartQuote must reference the same frozen composition version as identity", () => {
  const identity = { compositionId: "c-1", compositionVersionId: "cv-1", sceneHashSha256: SYNTHETIC_HASH_A, variantId: "variant-1", printProfileVersion: "profile-1" };
  assert.doesNotThrow(() => CompositionReviewProjectionV1Schema.parse({
    screenId: "ED-03", identity,
    displayedProof: { artifactId: "a-1", artifactSha256: SYNTHETIC_HASH_A, sourceCompositionVersionId: "cv-1", sourceSceneSha256: SYNTHETIC_HASH_A, status: "ready" },
    validation: null, cartQuote: null, newUnfrozenEditsExist: false, allowedActions: ["inspect"],
  }));
  assert.throws(() => CompositionReviewProjectionV1Schema.parse({
    screenId: "ED-03", identity,
    displayedProof: { artifactId: "a-1", artifactSha256: SYNTHETIC_HASH_A, sourceCompositionVersionId: "cv-STALE", sourceSceneSha256: SYNTHETIC_HASH_A, status: "ready" },
    validation: null, cartQuote: null, newUnfrozenEditsExist: true, allowedActions: ["inspect"],
  }));
});

test("digital export entitlement: public projection never carries verifiedCaptureId", () => {
  const internalEntitlement = DigitalExportEntitlementV1Schema.parse({
    status: "ready", entitlementId: "ent-1", ownerId: "owner-1", kind: "artwork_export",
    sourceVersionId: "v-1", sourceVersionSha256: SYNTHETIC_HASH_A, medusaOrderLineId: "line-1",
    verifiedCaptureId: "capture-1", rightsPolicyVersion: "rights-1", termsVersion: "terms-1",
    artifactId: "artifact-1", artifactSha256: SYNTHETIC_HASH_A, exportProfileVersion: "profile-1",
  });
  const publicEntitlement = toCustomerDigitalExportEntitlement(internalEntitlement);
  assert.ok(!Object.hasOwn(publicEntitlement, "verifiedCaptureId"));
  assert.doesNotThrow(() => CustomerDigitalExportEntitlementV1Schema.parse(publicEntitlement));
  assert.throws(() => CustomerDigitalExportEntitlementV1Schema.parse(internalEntitlement)); // strict: rejects the still-present verifiedCaptureId
});

test("StudioRecoveryProjectionV1: final_verified_uncharged_failure variants enforce C-02's open/closed pairing", () => {
  assert.doesNotThrow(() => StudioRecoveryProjectionV1Schema.parse({
    kind: "final_verified_uncharged_failure", attemptKind: "initial_final_before_original_closure",
    projectId: "project-1", originalPackageId: "pkg-1",
    preAttemptOriginalPackageClosure: "open", originalPackageClosure: "open",
    operationId: "op-1", originalQuoteId: "quote-1", releaseReceiptId: "receipt-1",
    previouslyDeliveredFinalVersionId: null, unusedOriginalRefinements: "preserve_pre_attempt_eligibility",
    retryRequiresNewAuthorization: true, customerMessage: "synthetic",
  }));
  // cross-wiring an initial attempt with a closed/open mismatch must fail every branch.
  assert.throws(() => StudioRecoveryProjectionV1Schema.parse({
    kind: "final_verified_uncharged_failure", attemptKind: "initial_final_before_original_closure",
    projectId: "project-1", originalPackageId: "pkg-1",
    preAttemptOriginalPackageClosure: "closed", originalPackageClosure: "open",
    operationId: "op-1", originalQuoteId: "quote-1", releaseReceiptId: "receipt-1",
    previouslyDeliveredFinalVersionId: null, unusedOriginalRefinements: "preserve_pre_attempt_eligibility",
    retryRequiresNewAuthorization: true, customerMessage: "synthetic",
  }));
});

test("fixtures module stays internally consistent (sanity check on helpers used across the suite)", () => {
  assert.equal(availabilityFixture.region, "US");
  assert.equal(conceptBundleQuoteFixture().offerKind, "concept_bundle_3x2");
  assert.equal(promoSinglePreviewQuoteFixture().creditsQuoted, 0);
});
