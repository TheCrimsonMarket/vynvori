// Pure SQL proposal builder. No DB/network/execution path. Input must be reviewed
// against the post-migration catalog; it is not a way to approve its own grants.
const runtime = "vynvori_medusa_runtime_scoped";
const migrator = "vynvori_medusa_migration_scoped";
const identifier = value => typeof value === "string" && value.length <= 63 && /^[a-z_][a-z0-9_]*$/.test(value);
const bookkeeping = value => /migration/i.test(value);
const check = (ok, code) => { if (!ok) throw new Error(code); };
export function runtimeGrantProposal(objects) {
  check(Array.isArray(objects) && objects.length > 0, "REVIEWED_OBJECT_LIST_REQUIRED");
  const seen = new Set();
  const tables = new Map(objects.filter(o => o.kind === "table").map(o => [o.name, o]));
  return objects.map(object => {
    check(object.schema === "public" && identifier(object.name) && object.owner === migrator &&
      typeof object.reason === "string" && object.reason.trim().length > 0, "OBJECT_SCOPE_OR_RATIONALE_INVALID");
    check(!seen.has(object.name), "DUPLICATE_OBJECT"); seen.add(object.name);
    check(Array.isArray(object.privileges) && object.privileges.length > 0 &&
      new Set(object.privileges).size === object.privileges.length, "PRIVILEGES_REQUIRED");
    if (object.kind === "table") {
      check(object.privileges.every(p => ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(p)), "NON_DML_PRIVILEGE_FORBIDDEN");
      check(!bookkeeping(object.name) || object.privileges.every(p => p === "SELECT"), "BOOKKEEPING_WRITES_FORBIDDEN");
    } else {
      check(object.kind === "sequence" && object.privileges.length === 1 && object.privileges[0] === "USAGE",
        "SEQUENCE_USAGE_ONLY");
      const parent = tables.get(object.table);
      check(!bookkeeping(object.name) && parent && !bookkeeping(parent.name) && parent.privileges.includes("INSERT"),
        "REVIEWED_INSERT_TABLE_REQUIRED");
    }
    return `GRANT ${object.privileges.join(", ")} ON ${object.kind === "table" ? "TABLE" : "SEQUENCE"} public."${object.name}" TO ${runtime};`;
  }).join("\n");
}
