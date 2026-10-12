import sharp from 'sharp';
import { readJson, root } from '../src/io.js';
import path from 'node:path';
import type { Model, Config, Brief, Task, RunRecord } from '../src/types.js';
export const setup = async () => ({
  models: await readJson<Model[]>(path.join(root,'config/models.json')),
  config: await readJson<Config>(path.join(root,'config/benchmark.json')),
  briefs: [await readJson<Brief>(path.join(root,'fixtures/briefs/CHAR-03.json'))],
  task: (await readJson<Task[]>(path.join(root,'config/concepts.json'))).find(t=>t.caseId==='CHAR-03')!
});
export const imageBytes=()=>sharp({create:{width:256,height:256,channels:4,background:'#926acd'}}).png().toBuffer();
export function memoryLedger(){const events:RunRecord[]=[];return {events,persist:async(r:RunRecord)=>{events.push(structuredClone(r));},records:async()=>[...new Map(events.map(r=>[r.runId,r])).values()]};}
