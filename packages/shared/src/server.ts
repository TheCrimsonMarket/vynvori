import "server-only";
import { featureDefaults, type FeatureFlags } from "./public";

export type Environment = "development" | "test" | "production";
export type Deployment = "local" | "development" | "preview" | "production";
export type ServerConfig = Readonly<{ environment: Environment; deployment: Deployment; features: FeatureFlags }>;
// Vercel injects these documented public build metadata keys for Next.js.
// They are ignored, never copied into our public configuration.
const platformPublicKeys = new Set([
  "NEXT_PUBLIC_VERCEL_ENV", "NEXT_PUBLIC_VERCEL_TARGET_ENV", "NEXT_PUBLIC_VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_BRANCH_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_HASH_SALT",
  "NEXT_PUBLIC_VERCEL_GIT_PROVIDER", "NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG", "NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER",
  "NEXT_PUBLIC_VERCEL_GIT_REPO_ID", "NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF", "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE", "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME", "NEXT_PUBLIC_VERCEL_GIT_PULL_REQUEST_ID",
]);

/** Values are intentionally never included in errors or logs. */
export function parseServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const environment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) {
    throw new Error("Invalid NODE_ENV; expected development, test or production.");
  }
  const deployment = env.VERCEL_ENV ?? "local";
  if (!["local", "development", "preview", "production"].includes(deployment)) {
    throw new Error("Invalid VERCEL_ENV; expected development, preview or production.");
  }
  if (env.VERCEL === "1" && env.VERCEL_ENV === undefined) throw new Error("VERCEL_ENV is required on Vercel.");
  for (const feature of Object.keys(featureDefaults)) {
    const key = `VYNVORI_${feature.replaceAll(".", "_").toUpperCase()}`;
    const value = env[key];
    if (value !== undefined && value !== "false") {
      throw new Error(`${key} must be false or unset; activation is unavailable in M0.`);
    }
  }
  // A typo must not look like a successfully configured integration.
  const keys = new Set(Object.keys(featureDefaults).map(f => `VYNVORI_${f.replaceAll(".", "_").toUpperCase()}`));
  for (const key of Object.keys(env)) {
    if (key.startsWith("VYNVORI_") && !keys.has(key)) throw new Error("Unknown VYNVORI configuration key.");
    if (key.startsWith("NEXT_PUBLIC_") && !platformPublicKeys.has(key)) throw new Error("Public environment configuration is not supported in M0.");
  }
  return Object.freeze({ environment: environment as Environment, deployment: deployment as Deployment, features: featureDefaults });
}

export function getServerConfig(): ServerConfig { return parseServerConfig(process.env); }
