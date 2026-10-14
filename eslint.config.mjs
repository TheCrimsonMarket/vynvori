import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
export default [
  ...nextVitals, ...nextTypescript,
  { ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts", "design/**"] },
  { settings: { next: { rootDir: "apps/web/" } } },
];
