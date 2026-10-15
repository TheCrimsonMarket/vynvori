import { defineConfig } from "drizzle-kit";
// Generation/checking never connects. Application is only via the guarded CLI.
export default defineConfig({ dialect: "postgresql", schema: "./src/schema.ts", out: "./migrations", strict: true });
