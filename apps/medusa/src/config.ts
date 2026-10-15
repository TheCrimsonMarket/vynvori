// Kept inside the backend: Cloud deploys only .medusa/server; no root-file imports.
type Env = Readonly<Record<string, string | undefined>>;
function need(env: Env, key: string) {
  const value = env[key];
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${key}`);
  return value;
}
export function medusaEnvironment(env: Env) {
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
  if (env.M2_ENV === "staging" && (database.hostname !== need(env, "M2_MEDUSA_DATABASE_HOST") || database.searchParams.get("sslmode") !== "verify-full")) throw new Error("Staging Medusa requires pinned host and verified TLS");
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
    databaseUrl: database.toString(),
    http: {
      storeCors: origins("M2_MEDUSA_STORE_CORS"), adminCors: origins("M2_MEDUSA_ADMIN_CORS"), authCors: origins("M2_MEDUSA_AUTH_CORS"),
      jwtSecret, cookieSecret,
      // No customer provider until the M1b trust remedy is approved and tested.
      authMethodsPerActor: { user: ["emailpass"], customer: [] as string[] },
    },
  };
}
