import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function walk(folder) {
  const files = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (["node_modules", ".next"].includes(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (/\.(?:ts|tsx|mjs|json|yml|md)$/.test(entry.name)) files.push(file);
  }
  return files;
}
const files = [...await walk(path.join(root, "apps/web")), ...await walk(path.join(root, "packages/shared")), ...await walk(path.join(root, ".github"))];
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text)) throw new Error(`Possible credential in ${path.relative(root, file)}`);
  if (/\.(?:ts|tsx)$/.test(file) && /dangerouslySetInnerHTML|\beval\s*\(|localStorage|fetch\s*\(/.test(text)) throw new Error(`Unexpected unsafe or integration surface in ${path.relative(root, file)}`);
  if (text.startsWith('"use client"') && /@vynvori\/shared\/server|process\.env|server-only/.test(text)) throw new Error(`Server import in client boundary: ${file}`);
}
const publicModule = await fs.readFile(path.join(root, "packages/shared/src/public.ts"), "utf8");
if (/process\.env/.test(publicModule)) throw new Error("Public config reads server environment.");
console.log(`PASS ${files.length} M0 source/config files: no known credential patterns, raw injection, client environment reads or integration calls. Smoke check only; not a comprehensive secret/security audit.`);
