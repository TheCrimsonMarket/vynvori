import { createRequire } from "node:module";
import { catalogConnection, collectCatalog } from "./medusa-catalog.mjs";
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
async function main() {
  const config = catalogConnection(process.env);
  const { Client } = require("pg");
  const client = new Client(config);
  client.on("error", () => {});
  const deadline = setTimeout(() => { void client.end().catch(() => {}); }, 20000);
  try {
    await client.connect();
    const report = await collectCatalog(client);
    // Do not emit partial evidence if connection cleanup fails.
    await client.end();
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(deadline);
    await client.end();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ version: 1, status: "FAILED", code: "CATALOG_COLLECTION_FAILED" }));
  process.exitCode = 1;
});
