import "server-only";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDatabase } from "./index";
if (process.env.M2_APPLY_MIGRATIONS !== "vynvori-creative-staging") throw new Error("Explicit staging migration acknowledgement required");
const connection = connectDatabase(process.env);
try {
  await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  console.log("Creative staging migrations applied");
} finally { await connection.close(); }
