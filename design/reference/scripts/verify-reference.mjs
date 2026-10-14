import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from '../serve.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(root,'REFERENCE-MANIFEST.json'),'utf8'));
for(const file of manifest.files){
  if(path.isAbsolute(file.path)||file.path.split('/').includes('..'))throw Error('Unsafe reference path');
  const bytes=await fs.readFile(path.join(root,file.path));
  if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw Error('Reference mismatch: '+file.path);
}
const provenance=JSON.parse(await fs.readFile(path.join(root,'docs/CONTRACT-PROVENANCE.json'),'utf8'));
for(const contract of provenance.contracts){
  const copy=await fs.readFile(path.join(root,contract.file));
  const canonical=await fs.readFile(path.resolve(root,'../../docs/technical/reference-contracts/v1.1',path.basename(contract.file)));
  if(hash(copy)!==contract.sha256||hash(copy)!==hash(canonical))throw Error('Canonical contract mismatch');
}
console.log(`Verified ${manifest.files.length} reference payloads and both canonical contract copies. No production acceptance claimed.`);
