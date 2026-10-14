/* Offline deterministic TypeScript erasure. Node >=22.23; no npm install required. */
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {runtimeOutput} from './runtime-output.mjs';
const inputs=['mock/reference/vynvori-v1_1-proposed.ts','mock/assets.ts','mock/service.ts','mock/corrections.ts'];
let output='/* Generated from typed mock sources by scripts/build.mjs. Do not edit. */\n(()=>{\n';
for(const file of inputs){let source=await fs.readFile(new URL('../'+file,import.meta.url),'utf8');source=stripTypeScriptTypes(source,{mode:'strip'});source=source.replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=(const|function|let|class))/g,'');output+=source+'\n';}
output+='globalThis.VynvoriMock=api;\n})();\n';
const target=path.join(runtimeOutput,'build','mock.js');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,output);
const shipped=await fs.readFile(new URL('../src/mock.js',import.meta.url),'utf8');if(shipped!==output)throw Error('Rebuild differs from immutable shipped bundle. No payload file was overwritten.');
console.log(`Offline rebuild matches shipped bundle byte-for-byte. Runtime build: ${target}. Payload unchanged.`);
