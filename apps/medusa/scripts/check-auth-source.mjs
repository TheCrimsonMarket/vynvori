import { readFile } from "node:fs/promises";
export async function checkAuthSource() {
  const canonical = await readFile(new URL("../../../packages/commerce/src/central-identity-core.ts", import.meta.url));
  const backend = await readFile(new URL("../src/auth/central-identity.ts", import.meta.url));
  if (!canonical.equals(backend)) throw new Error("Central identity protocol source differs between web and backend; review both before building");
  const proof = await readFile(new URL("../../../packages/commerce/src/medusa-proof-core.ts", import.meta.url));
  const backendProof = await readFile(new URL("../src/auth/medusa-proof.ts", import.meta.url));
  if (!proof.equals(backendProof)) throw new Error("Private Medusa proof protocol differs between web and backend");
}
