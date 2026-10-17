// Operator evidence only. Never applies migrations, grants, or reads domain rows.
export const runtimeRole = "vynvori_medusa_runtime_scoped";
export const migrationRole = "vynvori_medusa_migration_scoped";
const check = (ok, code) => { if (!ok) throw new Error(code); };
export function catalogConnection(env) {
  check(["local", "staging"].includes(env.M2_ENV), "CATALOG_ENV_INVALID");
  check(!env.M2_AUTHORIZE_MEDUSA_MIGRATION && (!env.NODE_TLS_REJECT_UNAUTHORIZED || env.NODE_TLS_REJECT_UNAUTHORIZED === "1"), "CATALOG_RUNTIME_ONLY");
  check(!Object.entries(env).some(([key, value]) => key.startsWith("VYNVORI_") && value !== undefined && value !== "false"), "CATALOG_FEATURES_DISABLED_REQUIRED");
  const url = new URL(env.M2_MEDUSA_DATABASE_URL);
  check(["postgres:", "postgresql:"].includes(url.protocol) && url.password &&
    decodeURIComponent(url.username) === runtimeRole && url.pathname === "/vynvori_medusa_staging" && !url.hash,
  "CATALOG_TARGET_INVALID");
  check([...url.searchParams.keys()].every(key => key === "sslmode"), "CATALOG_URL_OPTIONS_INVALID");
  if (env.M2_ENV === "staging") {
    check(url.hostname === env.M2_MEDUSA_DATABASE_HOST && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) &&
      !url.hostname.includes("-pooler.") && url.searchParams.get("sslmode") === "verify-full", "CATALOG_TLS_TARGET_INVALID");
  } else check(["localhost", "127.0.0.1"].includes(url.hostname), "CATALOG_LOOPBACK_REQUIRED");
  url.search = "";
  return { connectionString: url.toString(), ssl: env.M2_ENV === "staging" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 4000,
    application_name: "vynvori_catalog_read_only" };
}

export const catalogQueries = {
  identity: `SELECT current_database() AS database, session_user AS login, current_user AS actor,
    current_setting('transaction_read_only') AS read_only,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    has_database_privilege(current_user, current_database(), 'TEMP') AS temp,
    has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
    FROM pg_roles r WHERE r.rolname = current_user`,
  memberships: `SELECT r.rolname AS role FROM pg_roles r WHERE r.rolname <> current_user
    AND pg_has_role(current_user, r.oid, 'MEMBER') ORDER BY r.rolname LIMIT 10001`,
  objects: `SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
    CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END AS kind,
    c.relacl::text AS acl, c.relrowsecurity AS row_security,
    ARRAY(SELECT p FROM unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE','SELECT','UPDATE']
      ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END) p
      WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(current_user,c.oid,p)
        ELSE has_table_privilege(current_user,c.oid,p) END ORDER BY p) AS privileges,
    ARRAY(SELECT t.relname::text FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') AND tn.nspname = 'public'
      ORDER BY t.relname) AS tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S') ORDER BY c.relname LIMIT 10001`,
  defaults: `SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema,
    d.defaclobjtype AS kind, d.defaclacl::text AS acl FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE d.defaclnamespace = 0 OR n.nspname = 'public'
    ORDER BY owner, schema, kind LIMIT 10001`,
  functions: `SELECT n.nspname AS schema, p.proname AS name, p.oid::regprocedure::text AS signature,
    pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.proacl::text AS acl,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY signature LIMIT 10001`,
};

export async function collectCatalog(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const report = { version: 1, status: "REVIEW_REQUIRED", collectedAt: new Date().toISOString() };
    for (const [key, query] of Object.entries(catalogQueries)) {
      const { rows } = await client.query(query);
      check(rows.length <= 10000, "CATALOG_LIMIT_EXCEEDED");
      report[key] = rows;
      if (key === "identity") {
        const identity = rows[0];
        check(rows.length === 1 && identity.database === "vynvori_medusa_staging" &&
          identity.login === runtimeRole && identity.actor === runtimeRole && identity.read_only === "on",
        "CATALOG_IDENTITY_INVALID");
      }
    }
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// Complements the existing SQL builder: object identity and SERIAL/IDENTITY
// dependencies must come from the same collected catalog, not inferred names.
export function bindGrantProposal(objects, catalog) {
  check(catalog?.version === 1 && catalog.status === "REVIEW_REQUIRED" && Array.isArray(catalog.objects), "CATALOG_REQUIRED");
  check(Array.isArray(objects) && objects.length > 0, "PROPOSAL_REQUIRED");
  for (const object of objects) {
    const observed = catalog.objects.filter(row => row.schema === object.schema && row.name === object.name);
    check(observed.length === 1 && observed[0].kind === object.kind && observed[0].owner === migrationRole &&
      object.owner === migrationRole, "CATALOG_OBJECT_MISMATCH");
    if (object.kind === "sequence") check(observed[0].tables?.length === 1 && observed[0].tables[0] === object.table,
      "CATALOG_SEQUENCE_DEPENDENCY_MISMATCH");
  }
  return objects;
}
