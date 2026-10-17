// Executed only in a freshly built, local image, before application startup.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = [];
function walk(file) {
  const stat = fs.lstatSync(file);
  const record = [file, stat.mode & 0o7777, stat.uid, stat.gid];
  if (stat.isSymbolicLink()) files.push([...record, "link", fs.readlinkSync(file)]);
  else if (stat.isDirectory()) {
    files.push([...record, "directory"]);
    for (const entry of fs.readdirSync(file).sort()) walk(path.join(file, entry));
  } else if (stat.isFile()) files.push([...record, "file", hash(fs.readFileSync(file))]);
  else throw new Error("UNEXPECTED_RUNTIME_FILE_TYPE");
}
walk("/app");
console.log(JSON.stringify({ appFileTreeSha256: hash(JSON.stringify(files)), entries: files.length,
  nodeBinarySha256: hash(fs.readFileSync(process.execPath)), node: process.version, uid: process.getuid(), architecture: process.arch }));
