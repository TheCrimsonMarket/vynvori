import test from "node:test";
import assert from "node:assert/strict";
import { checkUploadDimensions, checkUploadFileSize, describeBytes, describeExpiry, type UploadLimits } from "../src/components/editor/model";

// SYNTHETIC test numbers only: not product policy and not founder values (ADR-0022).
const SYNTHETIC_UPLOAD_LIMITS: UploadLimits = { maxBytes: 3 * 1024 * 1024, maxPixels: 2_000_000, maxSidePx: 1800 };

test("file-size pre-check uses only the supplied limit, at the boundary and one over", () => {
  assert.deepEqual(checkUploadFileSize("a.png", SYNTHETIC_UPLOAD_LIMITS.maxBytes, SYNTHETIC_UPLOAD_LIMITS), { ok: true });
  const over = checkUploadFileSize("a.png", SYNTHETIC_UPLOAD_LIMITS.maxBytes + 1, SYNTHETIC_UPLOAD_LIMITS);
  assert.equal(over.ok, false); assert.equal(over.ok === false && over.reason, "size");
  assert.match(over.ok === false ? over.message : "", /3 MB maximum/);
  assert.equal(checkUploadFileSize("a.png", 11, { ...SYNTHETIC_UPLOAD_LIMITS, maxBytes: 10 }).ok, false, "a different limit changes the answer: no hidden copy");
});
test("pixel and longest-side pre-checks", () => {
  assert.deepEqual(checkUploadDimensions("a.png", 1000, 1500, SYNTHETIC_UPLOAD_LIMITS), { ok: true });
  const wide = checkUploadDimensions("a.png", 1801, 10, SYNTHETIC_UPLOAD_LIMITS); assert.equal(wide.ok === false && wide.reason, "side");
  const tall = checkUploadDimensions("a.png", 10, 1801, SYNTHETIC_UPLOAD_LIMITS); assert.equal(tall.ok === false && tall.reason, "side");
  const many = checkUploadDimensions("a.png", 1800, 1112, SYNTHETIC_UPLOAD_LIMITS); assert.equal(many.ok === false && many.reason, "pixels");
  assert.match(many.ok === false ? many.message : "", /2,000,000 pixels/);
  assert.deepEqual(checkUploadDimensions("a.png", 1000, 1800, SYNTHETIC_UPLOAD_LIMITS), { ok: true });
});
test("byte descriptions come from the number given", () => {
  assert.equal(describeBytes(2 * 1024 * 1024), "2 MB"); assert.equal(describeBytes(1536 * 1024), "1.5 MB"); assert.equal(describeBytes(512 * 1024), "512 KB");
});
test("expiry wording derives from expiresAt and never names a duration", () => {
  const text = describeExpiry("2030-01-02T03:04:00.000Z", "en-US", "UTC");
  assert.match(text, /^until Jan 2, 2030/); assert.doesNotMatch(text, /hour/i);
  assert.equal(describeExpiry(null), "until it expires"); assert.equal(describeExpiry("not a date"), "until it expires");
});
