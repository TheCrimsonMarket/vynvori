import assert from "node:assert/strict";
import { test } from "node:test";
import { GET, dynamic, revalidate } from "../src/app/api/health/route";
test("health reports process liveness only with no caching or sensitive fields", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
  assert.equal(dynamic, "force-dynamic"); assert.equal(revalidate, 0);
});
