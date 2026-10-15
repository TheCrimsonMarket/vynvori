import { sql } from "drizzle-orm";
import { pgSchema, uuid, text, timestamp, check } from "drizzle-orm/pg-core";
export const infrastructure = pgSchema("vynvori_infrastructure");
// Synthetic infrastructure evidence only. No identity, financial or job schema.
export const probes = infrastructure.table("synthetic_probes", {
  id: uuid("id").primaryKey(),
  fixture: text("fixture").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [check("synthetic_only", sql`${table.fixture} = 'm2-synthetic-v1'`)]);
