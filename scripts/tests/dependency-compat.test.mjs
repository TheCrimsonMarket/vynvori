import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

test("Rushstack consumes patched AJV and still validates its JSON schemas", () => {
  const consumer = createRequire(require.resolve("@rushstack/node-core-library"));
  assert.equal(consumer("ajv/package.json").version, "8.20.0");
  const { JsonSchema } = require("@rushstack/node-core-library");
  const schema = JsonSchema.fromLoadedObject({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object", properties: { fixture: { const: "m2-synthetic-v1" } }, required: ["fixture"], additionalProperties: false,
  });
  assert.doesNotThrow(() => schema.validateObject({ fixture: "m2-synthetic-v1" }, "synthetic.json"));
  assert.throws(() => schema.validateObject({ fixture: "invalid" }, "synthetic.json"));
});

// ADR-0024: Medusa 2.23.1 moves to BullMQ 6, which dropped the uuid package and calls node:crypto randomUUID.
// The old keyed override (bullmq@5.13.0 > uuid 11.1.1, GHSA-w5hq-g745-h8pq) no longer matches anything and was
// removed. These checks keep the original guarantee: no uuid copy below 11.1.1 is reachable from BullMQ or anywhere.
test("BullMQ 6 needs no uuid package and its job-id API still yields v4 UUIDs", () => {
  const manifest = require("bullmq/package.json");
  assert.equal(manifest.version, "6.7.6");
  for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(manifest[kind]?.uuid, undefined, kind);
  const dist = path.join(path.dirname(require.resolve("bullmq/package.json")), "dist");
  const sources = fs.readdirSync(dist, { recursive: true }).filter(file => /\.(?:c?js|mjs)$/.test(file));
  assert.ok(sources.length > 50);
  for (const file of sources) assert.doesNotMatch(fs.readFileSync(path.join(dist, file), "utf8"), /(?:require\(|from |import\()\s*["']uuid["']/, file);
  const { randomUUID } = require("bullmq/dist/cjs/utils");
  assert.equal(randomUUID, crypto.randomUUID);
  const id = randomUUID();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("no installed uuid copy is below the patched 11.1.1", () => {
  const lock = JSON.parse(fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!/(?:^|\/)node_modules\/uuid$/.test(location)) continue;
    const [major, minor, patch] = entry.version.split(".").map(Number);
    assert.ok(major > 11 || (major === 11 && (minor > 1 || (minor === 1 && patch >= 1))), `${location}@${entry.version}`);
  }
});
