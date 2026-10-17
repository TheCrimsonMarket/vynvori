// Kept inside the backend: Cloud deploys only .medusa/server; no root-file imports.
type Env = Readonly<Record<string, string | undefined>>;
function need(env: Env, key: string) {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${key}`);
  return value;
}
export function medusaEnvironment(env: Env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw new Error("TLS verification override forbidden");
  if (env.M2_ENV !== "local" && env.M2_ENV !== "staging") throw new Error("M2_ENV must be local or staging");
  for (const key of Object.keys(env)) {
    if (key.startsWith("VYNVORI_") && env[key] !== undefined && env[key] !== "false") throw new Error("All operational features must remain disabled");
    if (key.startsWith("NEXT_PUBLIC_M2_")) throw new Error("Public backend configuration is forbidden");
  }
  let database: URL;
  try { database = new URL(need(env, "M2_MEDUSA_DATABASE_URL")); } catch { throw new Error("Invalid Medusa database configuration"); }
  const name = need(env, "M2_MEDUSA_DATABASE_NAME");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.username || !database.password ||
      decodeURIComponent(database.pathname.slice(1)) !== name || /creative/i.test(name)) throw new Error("Medusa database isolation failed");
  if (env.M2_ENV === "local" && (!["127.0.0.1", "localhost"].includes(database.hostname) || name !== "vynvori_medusa_staging")) throw new Error("Local Medusa database must be isolated on loopback");
  const databaseRole = env.M2_AUTHORIZE_MEDUSA_MIGRATION === "vynvori_medusa_staging"
    ? "vynvori_medusa_migration_scoped" : "vynvori_medusa_runtime_scoped";
  if (env.M2_ENV === "staging" && (database.hostname !== need(env, "M2_MEDUSA_DATABASE_HOST") ||
      !database.hostname.endsWith(".neon.tech") || database.hostname.includes("-pooler.") ||
      name !== "vynvori_medusa_staging" || decodeURIComponent(database.username) !== databaseRole ||
      database.searchParams.get("sslmode") !== "verify-full")) throw new Error("Staging Medusa requires pinned direct Neon host, isolated role and verified TLS");
  // pg connection-string SSL options replace an explicit SSL object. Validate then
  // strip them so Medusa/Knex and native migrations receive the same TLS policy.
  for (const key of database.searchParams.keys()) {
    if (key !== "sslmode") throw new Error("Unsupported Medusa database URL option");
  }
  database.search = "";
  if (env.M2_CREATIVE_DATABASE_URL) {
    let other: URL;
    try { other = new URL(env.M2_CREATIVE_DATABASE_URL); } catch { throw new Error("Invalid peer database configuration"); }
    if (database.hostname === other.hostname && database.port === other.port && database.pathname === other.pathname) throw new Error("Medusa and creative databases must differ");
  }
  function origins(key: string) {
    const values = need(env, key).split(",");
    for (const value of values) {
      let origin: URL;
      try { origin = new URL(value); } catch { throw new Error(`Invalid ${key}`); }
      if (origin.origin !== value || origin.username || origin.password ||
          (env.M2_ENV === "staging" ? origin.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(origin.hostname) : origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname))) throw new Error(`Unsafe ${key}`);
    }
    return values.join(",");
  }
  const jwtSecret = need(env, "M2_MEDUSA_JWT_SECRET");
  const cookieSecret = need(env, "M2_MEDUSA_COOKIE_SECRET");
  if (jwtSecret.length < 32 || cookieSecret.length < 32 || jwtSecret === cookieSecret) throw new Error("Separate strong Medusa secrets required");
  return {
    workerMode: "shared" as const,
    databaseUrl: database.toString(),
    databaseDriverOptions: {
      connection: { ssl: env.M2_ENV === "staging" ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5000 },
      // The pinned Medusa loader forwards only these pool settings. Readiness
      // owns a separate bounded pg connection; do not claim a shared acquire cap.
      pool: { min: 0, max: 5, idleTimeoutMillis: 10000 },
    },
    http: {
      storeCors: origins("M2_MEDUSA_STORE_CORS"), adminCors: origins("M2_MEDUSA_ADMIN_CORS"), authCors: origins("M2_MEDUSA_AUTH_CORS"),
      jwtSecret, cookieSecret,
      // No customer provider until the M1b trust remedy is approved and tested.
      authMethodsPerActor: { user: ["emailpass"], customer: [] as string[] },
    },
  };
}
