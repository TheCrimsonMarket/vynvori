import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["apps/medusa", "packages/db", "packages/commerce", "packages/shared", "services/image-processing", "scripts/process-lifecycle.mjs", "scripts/test-medusa.mjs", "scripts/tests", "docs/implementation/M2.md", "docs/implementation/M2-security-advisories.md", "docs/implementation/ADR-0003-M2-foundation.md"];
let count = 0;
async function inspect(relative) {
  const target = path.join(root, relative);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) if (!["node_modules", ".medusa", "dist"].includes(entry)) await inspect(path.join(relative, entry));
    return;
  }
  const text = await fs.readFile(target, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|eyJ[A-Za-z0-9_-]{20,}\.eyJ/.test(text)) throw new Error(`Potential credential: ${relative}`);
  if (/NEXT_PUBLIC_M2_\w+\s*=\s*[^\s]/.test(text)) throw new Error(`Public integration credential: ${relative}`);
  count++;
}
for (const folder of roots) await inspect(folder);
const webFiles = ["apps/web/src/app/api/health/route.ts", "apps/web/src/app/page.tsx"];
for (const file of webFiles) {
  const text = await fs.readFile(path.join(root, file), "utf8");
  if (/@vynvori\/(commerce|db)|M2_|DATABASE_URL/.test(text)) throw new Error("Public M0 surface depends on infrastructure");
}
console.log(`PASS ${count} M2 files: known-secret pattern smoke and public integration isolation (not comprehensive security acceptance)`);
