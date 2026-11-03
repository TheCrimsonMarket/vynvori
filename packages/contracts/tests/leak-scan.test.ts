import assert from "node:assert/strict";
import { test } from "node:test";
import { findLeakedInternalFields } from "../src/errors";
import { StudioStatusV3Schema } from "../src/screens";
import { availabilityFixture, conceptBundleQuoteFixture } from "./fixtures";

test("findLeakedInternalFields finds nothing in a well-formed public StudioStatusV3 projection", () => {
  const status = StudioStatusV3Schema.parse({
    schemaVersion: "studio-status.v3", projectId: "project-1",
    plan: { kind: "unapproved", conceptSlots: [] },
    deliveredConceptCount: 0, packageState: null, promoStatus: "eligible",
    customerOperations: [], bundleFinancials: null,
    capabilities: availabilityFixture, allowedActions: ["resume"], currentErrorCode: null,
    refinements: [],
  });
  assert.deepEqual(findLeakedInternalFields(status), []);
  assert.deepEqual(findLeakedInternalFields(conceptBundleQuoteFixture()), []);
});

test("findLeakedInternalFields detects every forbidden key, however deeply nested", () => {
  assert.deepEqual(findLeakedInternalFields({ providerJobId: "job-1" }), ["providerJobId"]);
  assert.deepEqual(findLeakedInternalFields({ outer: { inner: { privateVendorCostUsd: 4.2 } } }), ["privateVendorCostUsd"]);
  assert.deepEqual(findLeakedInternalFields([{ vendorCostEvidence: "usage" }, { staffNotes: "x" }]), ["vendorCostEvidence", "staffNotes"]);
  assert.deepEqual(findLeakedInternalFields("not-an-object"), []);
  assert.deepEqual(findLeakedInternalFields(null), []);
});

test("findLeakedInternalFields detects the ledger-internal keys added for M7 (flat and nested) and public fixtures stay clean", () => {
  for (const key of ["requestSha256", "evidenceRef", "modelRef", "contentSha256"]) {
    assert.deepEqual(findLeakedInternalFields({ [key]: "x" }), [key], key + " flat");
    assert.deepEqual(findLeakedInternalFields({ outer: [{ inner: { [key]: "x" } }] }), [key], key + " nested");
  }
  // capabilitySnapshotId is a deliberate PUBLIC field and must never be forbidden.
  assert.deepEqual(findLeakedInternalFields({ capabilitySnapshotId: "cap-1" }), []);
  assert.deepEqual(findLeakedInternalFields(conceptBundleQuoteFixture()), []);
  assert.deepEqual(findLeakedInternalFields(availabilityFixture), []);
});
