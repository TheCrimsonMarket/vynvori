import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const root = new URL('../', import.meta.url);
const events=(await readFile(new URL('results/runs/ledger.jsonl',root),'utf8')).trim().split('\n').map(JSON.parse);
const records=[...new Map(events.map(r=>[r.runId,r])).values()].filter(r=>r.mode==='live'&&r.attempts>0);
const completed=records.filter(r=>r.status==='completed');
for(const r of completed) {
  const bytes=await readFile(new URL('results/'+r.output.assetPath,root));
  if(createHash('sha256').update(bytes).digest('hex')!==r.output.sha256)throw new Error('Checksum mismatch');
  const meta=await sharp(bytes).metadata();if(meta.width!==r.output.width||meta.height!==r.output.height)throw new Error('Dimension mismatch');
}
const followups=completed.filter(r=>r.operation!=='concept');
if(new Set(followups.map(r=>JSON.stringify(r.inputAssetHashes))).size!==1)throw new Error('Follow-up source input differs');
const sampleMap=JSON.parse(await readFile(new URL('results/private/blind-map.json',root),'utf8'));
const html=await readFile(new URL('results/report/blind-review.html',root),'utf8');
for(const model of new Set(records.map(r=>r.modelId)))if(html.includes(model))throw new Error('Model identity leaked into blind review');
for(const sample of sampleMap) {
  await stat(new URL('results/report/'+sample.artifact,root));
  await stat(new URL('results/report/blind-artifacts/'+sample.sampleId+'-native.png',root));
}
const usage=records.reduce((sum,r)=>sum+(r.billing.amountUsd??0),0);
const key=JSON.parse(await readFile(new URL('results/private/key-status-latest.json',root),'utf8'));
if(Math.abs(usage-key.usage)>0.000001)throw new Error('Provider key usage does not reconcile to requests');
const handoff=new URL('../../../output/vynvori-ai-benchmark-results/',import.meta.url);
let scanned=0;
async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const url=new URL(entry.name+(entry.isDirectory()?'/':''),dir);
  if(entry.isDirectory()){await scan(url);continue;}
  if(entry.name==='.env')throw new Error('Secret environment file in handoff');
  const bytes=await readFile(url);scanned++;
  if(process.env.OPENROUTER_API_KEY && bytes.includes(Buffer.from(process.env.OPENROUTER_API_KEY)))throw new Error('Credential bytes found in handoff');
  if(process.env.FAL_KEY && bytes.includes(Buffer.from(process.env.FAL_KEY)))throw new Error('Credential bytes found in handoff');
}}
await scan(handoff);
console.log(JSON.stringify({verifiedImages:completed.length,requests:records.length,commonSourceFollowups:followups.length,usageUsd:Number(usage.toFixed(9)),keyUsageUsd:key.usage,unresolved:records.filter(r=>['running','unknown'].includes(r.status)).length,blindSamples:sampleMap.length,secretScanFiles:scanned,credentialsInHandoff:false}));
