import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { compositionStore } from "@vynvori/db/composition";
import { compositionConformance, type Harness } from "./composition-suite";
import { freshComposition } from "../../db/tests/composition-fixture";
// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";

const connection = process.env.M3_TEST_POSTGRES_URL;
/** The identical behavioural suite, against the real SQL store, constraints and triggers. */
compositionConformance("composition service (PostgreSQL store)", async (): Promise<Harness> => {
  const admin = await freshComposition("vynvori_m3_service_test"); await admin.end();
  const pool = new Pool({ connectionString: connection!.replace("vynvori_m3_migration_test", "vynvori_m3_service_test"), max: 4 });
  return {
    store: compositionStore(pool),
    async newUser() { const id = randomUUID(); await pool.query("INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://issuer.test',$2)", [id, id]); return id; },
    async m1bClaim(draftId, userId) { await pool.query("UPDATE vynvori_identity.guest_drafts SET owner_id=$2, claimed_at=now() WHERE id=$1", [draftId, userId]); },
  };
}, { skip: !connection && !requirePg });
