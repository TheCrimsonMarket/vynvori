import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
export default [
  ...nextVitals, ...nextTypescript,
  { ignores: ["**/node_modules/**", "**/.next/**", "**/.medusa/**", "**/next-env.d.ts", "design/**", "packages/db/migrations/**"] },
  { settings: { next: { rootDir: "apps/web/" } } },
];
