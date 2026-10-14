import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {root} from '../serve.mjs';
export const runtimeOutput=path.resolve(process.env.VYNVORI_TEST_OUTPUT_DIR||path.join(tmpdir(),'VYNVORI-FINAL-runs',`${Date.now()}-${process.pid}`));
if(runtimeOutput===root||runtimeOutput.startsWith(root+path.sep))throw Error('Runtime output must be outside the immutable package directory.');
await fs.mkdir(runtimeOutput,{recursive:true});
export async function resultFile(name,value){const file=path.join(runtimeOutput,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');console.log(`Runtime evidence: ${file}`);return file;}
export async function screenshotPath(name){const file=path.join(runtimeOutput,name);await fs.mkdir(path.dirname(file),{recursive:true});return file;}
