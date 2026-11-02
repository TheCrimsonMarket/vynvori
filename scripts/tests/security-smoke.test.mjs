import test from "node:test";
import assert from "node:assert/strict";
import { inspectSource } from "../security-smoke.mjs";
const account = "apps/web/src/components/auth-panel.tsx";
test("BFF fetch allowance stays confined to the two identity components", () => {
  inspectSource(account, '"use client"; fetch("/api/auth/session")');
  inspectSource("apps/web/src/components/account-details.tsx", '"use client"; fetch("/api/account/profile")');
  assert.throws(() => inspectSource("apps/web/src/components/other.tsx", 'fetch("/api/account/profile")'), /integration/);
  assert.throws(() => inspectSource("packages/shared/src/public.ts", 'fetch("https://example.invalid")'), /integration/);
});
test("identity components retain injection, storage and server-import prohibitions", () => {
  for (const code of ['eval("x")', "localStorage.setItem('x','y')", "dangerouslySetInnerHTML", "process.env.SECRET", "import 'server-only'", "import '@vynvori/shared/server'"])
    assert.throws(() => inspectSource(account, '"use client"; ' + code));
});
test("credential detection remains active in allowed components", () => {
  assert.throws(() => inspectSource(account, "AKIA" + "A".repeat(16)), /credential/);
});
