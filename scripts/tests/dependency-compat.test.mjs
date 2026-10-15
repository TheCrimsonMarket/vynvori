import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

test("BullMQ resolves patched CommonJS UUID and its used v4 API remains compatible", () => {
  const consumer = createRequire(require.resolve("bullmq"));
  assert.equal(consumer("uuid/package.json").version, "11.1.1");
  const { v4, validate, version } = consumer("uuid");
  const id = v4();
  assert.equal(validate(id), true);
  assert.equal(version(id), 4);
  assert.equal(typeof id, "string");
});
