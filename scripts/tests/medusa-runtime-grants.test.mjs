import test from "node:test";
import assert from "node:assert/strict";
import { runtimeGrantProposal } from "../medusa-runtime-grants.mjs";
const object = { schema: "public", name: "synthetic_domain", owner: "vynvori_medusa_migration_scoped", kind: "table",
  privileges: ["SELECT", "INSERT"], reason: "Synthetic native module read/create fixture; not an actual catalog" };
test("proposal emits only explicitly reviewed object privileges for scoped runtime", () => {
  const sql = runtimeGrantProposal([object, { ...object, kind: "sequence", name: "synthetic_domain_id_seq", table: object.name, privileges: ["USAGE"] },
    { ...object, name: "script_migrations", privileges: ["SELECT"] }]);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\."synthetic_domain" TO vynvori_medusa_runtime_scoped;/);
  assert.match(sql, /GRANT USAGE ON SEQUENCE/);
  assert.doesNotMatch(sql, /ALL TABLES|ALL SEQUENCES|ALTER|DEFAULT|OWNER|neon_superuser/);
});
test("rejects bookkeeping writes/sequences, unowned objects and broad privileges", () => {
  for (const name of ["mikro_orm_migrations", "script_migrations", "link_module_migrations", "future_module_migrations"]) {
    assert.throws(() => runtimeGrantProposal([{ ...object, name }]), /BOOKKEEPING_WRITES_FORBIDDEN/);
    assert.throws(() => runtimeGrantProposal([{ ...object, name, privileges: ["SELECT"] },
      { ...object, kind: "sequence", name: `${name}_id_seq`, table: name, privileges: ["USAGE"] }]));
  }
  for (const patch of [{ owner: "vynvori_medusa_app" }, { owner: "vynvori_medusa_runtime_scoped" }, { schema: "creative" },
    { privileges: ["ALL"] }, { privileges: ["TRUNCATE"] }, { privileges: ["REFERENCES"] }, { privileges: ["TRIGGER"] },
    { name: "domain; DROP TABLE x" }, { name: "a".repeat(64) }, { reason: "" }, { privileges: [] }]) {
    assert.throws(() => runtimeGrantProposal([{ ...object, ...patch }]));
  }
  assert.throws(() => runtimeGrantProposal([object, object]), /DUPLICATE_OBJECT/);
  assert.throws(() => runtimeGrantProposal([]));
  assert.throws(() => runtimeGrantProposal([{ ...object, kind: "sequence", privileges: ["UPDATE"] }]));
  assert.throws(() => runtimeGrantProposal([{ ...object, kind: "sequence", privileges: ["USAGE"], table: "unreviewed" }]));
});
