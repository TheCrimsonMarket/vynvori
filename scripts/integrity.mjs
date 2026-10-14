import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "docs/implementation/M0-protected-files.json"), "utf8"));
for (const file of manifest.files) {
  if (path.isAbsolute(file.path) || file.path.split("/").includes("..")) throw new Error("Unsafe integrity path.");
  const bytes = await fs.readFile(path.join(root, file.path));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  // Two inherited CSVs have CRLF checkout bytes and LF baseline Git blobs.
  // Accept only their recorded exact hash pair, not arbitrary normalization.
  if (digest !== file.sha256 && digest !== file.gitBlobSha256) throw new Error(`Protected source changed: ${file.path}`);
}
console.log(`PASS ${manifest.files.length} protected canonical, reference and original logo files match baseline/checkout hashes from ${manifest.baseline}.`);
const assets = [
  ["public/assets/vynvori-wordmark-black.svg", "logo/svg/vynvori-wordmark-black.svg"],
  ["public/assets/vynvori-symbol-black.svg", "logo/svg/vynvori-symbol-black.svg"],
  ...["campaign.png", "blank-garment.png", "arch-study.svg", "studio-sentinel-study.svg"].map(file => [`public/assets/${file}`, `design/reference/assets/${file}`]),
  ...["archivo.ttf", "archivo-OFL.txt", "archivo-METADATA.pb"].map(file => [`src/fonts/${file}`, `design/reference/assets/fonts/${file}`]),
];
for (const [destination, source] of assets) {
  if (!(await fs.readFile(path.join(root,"apps/web",destination))).equals(await fs.readFile(path.join(root,source)))) throw new Error(`Asset copy changed: ${destination}`);
}
console.log(`PASS ${assets.length} app asset/font/license copies match retained source bytes.`);
