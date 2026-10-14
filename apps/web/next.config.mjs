import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  agentRules: false,
  transpilePackages: ["@vynvori/shared"],
  outputFileTracingRoot: root,
  outputFileTracingExcludes: { "/*": ["../../design/**/*", "../../docs/**/*", "../../logo/**/*", "../../packages/shared/tests/**/*"] },
  turbopack: { root },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" },
    ] }];
  },
};
export default config;
