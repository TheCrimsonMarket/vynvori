import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identityBffClients = new Set(["apps/web/src/components/auth-panel.tsx", "apps/web/src/components/account-details.tsx"]);
export function inspectSource(file, text) {
  file = file.replaceAll("\\", "/");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text)) throw new Error(`Possible credential in ${file}`);
  if (/\.(?:ts|tsx)$/.test(file) && /dangerouslySetInnerHTML|\beval\s*\(|localStorage/.test(text)) throw new Error(`Unexpected unsafe surface in ${file}`);
  // M1b's two reviewed component boundaries call the app BFF. Every other source retains M0's fetch prohibition.
  if (/\.(?:ts|tsx)$/.test(file) && /fetch\s*\(/.test(text) && !identityBffClients.has(file)) throw new Error(`Unexpected integration surface in ${file}`);
  if (text.startsWith('"use client"') && /@vynvori\/shared\/server|process\.env|server-only/.test(text)) throw new Error(`Server import in client boundary: ${file}`);
}
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
async function main() {
const files = [...await walk(path.join(root, "apps/web")), ...await walk(path.join(root, "packages/shared")), ...await walk(path.join(root, ".github"))];
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  inspectSource(path.relative(root, file), text);
}
const publicModule = await fs.readFile(path.join(root, "packages/shared/src/public.ts"), "utf8");
if (/process\.env/.test(publicModule)) throw new Error("Public config reads server environment.");
console.log(`PASS ${files.length} source/config files: credential/injection/client-environment checks; BFF fetch permitted only in the two M1b account components. Smoke check only; not a comprehensive secret/security audit.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
