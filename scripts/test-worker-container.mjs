import assert from "node:assert/strict";
const origin = "http://127.0.0.1:18080";
for (let attempt = 0; attempt < 20; attempt++) {
  try { if ((await fetch(`${origin}/health`)).status === 200) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal((await fetch(`${origin}/ready`)).status, 401);
const response = await fetch(`${origin}/v1/dry-run`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-ci-worker-token-000000000000" }, body: JSON.stringify({ version: 1, fixture: "m2-synthetic-v1", requestId: "12345678-1234-4123-8123-123456789abc" }) });
assert.equal(response.status, 200);
assert.equal((await response.json()).printed, false);
console.log("PASS actual container HTTP dry-run; unauthenticated access rejected");
