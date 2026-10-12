import { randomBytes } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { csv, json, latest, loadEvents, readJson, results, root, safePath, sha256 } from './io.js';
import { percentile, quality } from './evaluators/comparison.js';
import type { Score } from './evaluators/comparison.js';
import type { Config, RunRecord } from './types.js';
import { simulate } from './economics.js';
import type { EconomicsInput } from './economics.js';
export interface BlindMapping { sampleId: string; runId: string; artifact: string; sourceSampleId: string | null; caseId: string; operation: string }
const escapeHtml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function optionalJson<T>(file: string, fallback: T): Promise<T> {
  try { return await readJson<T>(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
}
export async function exportReport() {
  const records = latest(await loadEvents<RunRecord>());
  const live = records.filter(r => r.mode === 'live' && r.attempts > 0);
  const config = await readJson<Config>(path.join(root, 'config/benchmark.json'));
  const reportDir = path.join(results, 'report'); await mkdir(reportDir, { recursive: true });
  await mkdir(path.join(reportDir,'blind-artifacts'),{recursive:true});
  const privateDir = path.join(results, 'private'); await mkdir(privateDir, { recursive: true });
  const mappings = await optionalJson<BlindMapping[]>(path.join(privateDir, 'blind-map.json'), []);
  for (const r of live.filter(r => r.output)) {
    const verifiedBytes = await readFile(safePath(results, r.output!.assetPath));
    if (sha256(verifiedBytes) !== r.output!.sha256) throw new Error('Artifact checksum mismatch');
    const existing = mappings.find(m => m.runId === r.runId);
    const sampleId = existing?.sampleId ?? 'S-' + randomBytes(5).toString('hex');
    const artifact = `blind-artifacts/${sampleId}.png`;
    await mkdir(path.join(reportDir, 'blind-artifacts'), { recursive: true });
    const bytes = await readFile(safePath(results, r.output!.assetPath));
    if (sha256(bytes) !== r.output!.sha256) throw new Error('Artifact checksum mismatch');
    // Identical canvas and flattened black backing, with metadata removed for blind review.
    await sharp(bytes).resize(768,1024,{fit:'contain',background:'#080808'}).flatten({ background: '#080808' }).png().toFile(path.join(reportDir, artifact));
    await sharp(bytes).png().toFile(path.join(reportDir, 'blind-artifacts', sampleId + '-native.png'));
    if (!existing) mappings.push({ sampleId, runId: r.runId, artifact, sourceSampleId: null, caseId: r.caseId, operation: r.operation });
  }
  for (const mapping of mappings) {
    const r = live.find(r => r.runId === mapping.runId);
    mapping.sourceSampleId = mappings.find(m => m.runId === r?.sourceRunId)?.sampleId ?? null;
  }
  await json(path.join(privateDir, 'blind-map.json'), mappings);
  const shuffled = [...mappings].sort((a,b) => sha256(a.sampleId).localeCompare(sha256(b.sampleId)));
  const scoreRows = await optionalJson<Score[]>(path.join(reportDir, 'scores.json'), []);
  await writeFile(path.join(reportDir, 'blind-scores.csv'), csv(scoreRows as unknown as Record<string,unknown>[], ['sampleId','reviewerId','originality','moodboard','editPreservation','printSuitability','accepted','ipPass','edgesPass','genuineTransparency','notes']));
  await json(path.join(reportDir, 'review-samples.json'), shuffled.map(({runId,...safe}) => safe));
  const cards = shuffled.map(m => {
    const before = m.sourceSampleId ? mappings.find(x => x.sampleId === m.sourceSampleId) : undefined;
    const prompt=live.find(r=>r.runId===m.runId)?.sentPrompt??'';
    return `<article data-sample="${m.sampleId}"><h2>${m.sampleId} · ${m.caseId} · ${m.operation}</h2><p>${escapeHtml(prompt)}</p>${before ? `<figure><figcaption>Source before requested change</figcaption><img src="${before.artifact}" alt="Source artwork"/></figure>` : ''}<img src="${m.artifact}" alt="Sample ${m.sampleId}"/><p><a href="blind-artifacts/${m.sampleId}-native.png" target="_blank">Inspect full-resolution artwork and transparency</a></p>${['originality','moodboard','editPreservation','printSuitability'].map(field => `<label>${field}<select name="${field}" required><option value="">Score 1–5</option>${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></label>`).join('')}${['accepted','ipPass','edgesPass','genuineTransparency'].map(field=>`<label><input type="checkbox" name="${field}"/>${field}</label>`).join('')}<label>Notes<textarea name="notes" maxlength="3000"></textarea></label></article>`;
  }).join('\n');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vynvori blind review</title><style>body{font:16px system-ui;background:#15151b;color:#eee;max-width:980px;margin:auto;padding:24px}article{background:#22222a;border-radius:12px;padding:24px;margin:28px 0}img{max-width:46%;vertical-align:top}figure{display:inline-block;width:46%;margin:0}figure img{max-width:100%}label{display:block;margin:12px 0}select,textarea,input{font:inherit}textarea{width:95%;min-height:60px}button{padding:12px;font:inherit}header{position:sticky;top:0;background:#15151b;padding:16px}</style><header><h1>Blind artwork review</h1><p>${shuffled.length} real generated samples. Keep model names and costs hidden until both reviews are submitted.</p><label>Anonymous reviewer ID <input id="reviewer" pattern="[A-Za-z0-9_-]{1,50}" required placeholder="reviewer-1"></label><button id="save">Download scores JSON</button><p id="message" role="status"></p></header><p>Score 1 (unusable) to 5 (excellent). Judge originality, fit to the brief, preservation in edits, and print suitability. For concepts/finals, edit preservation is excluded from the quality score. Check acceptance and inspection boxes only after review of the original at full resolution; the black review canvas hides alpha defects. This sheet cannot prove physical print quality.</p>${cards || '<p>No generated images yet. Dry-run plans contain no artwork and must not be scored.</p>'}<script>document.getElementById('save').onclick=()=>{const reviewerId=document.getElementById('reviewer').value;if(!/^[\\w-]{1,50}$/.test(reviewerId)){document.getElementById('message').textContent='Enter an anonymous reviewer ID.';return}const rows=[];for(const a of document.querySelectorAll('article')){const r={sampleId:a.dataset.sample,reviewerId,notes:a.querySelector('textarea').value};for(const s of a.querySelectorAll('select')){if(!s.value){document.getElementById('message').textContent='Score every sample before downloading.';return}r[s.name]=Number(s.value)}for(const c of a.querySelectorAll('[type=checkbox]'))r[c.name]=c.checked;rows.push(r)}const u=URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=u;link.download=reviewerId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(u),1000);document.getElementById('message').textContent='Saved. Send the JSON file for import.'};</script></html>`;
  await writeFile(path.join(reportDir,'blind-review.html'), html);
  // A separate reviewer bundle must not contain the report's raw ledger or model/cost CSVs.
  const reviewDir=path.join(results,'review');await mkdir(reviewDir,{recursive:true});
  await writeFile(path.join(reviewDir,'blind-review.html'),html);
  await cp(path.join(reportDir,'blind-artifacts'),path.join(reviewDir,'blind-artifacts'),{recursive:true});
  await json(path.join(reviewDir,'review-samples.json'),shuffled.map(({runId,...safe})=>safe));
  await cp(path.join(root,'fixtures/references'),path.join(reviewDir,'references'),{recursive:true});
  await cp(path.join(root,'fixtures/briefs'),path.join(reviewDir,'briefs'),{recursive:true});
  await copyFile(path.join(root,'docs/04-evaluation-rubric.md'),path.join(reviewDir,'rubric.md'));
  const manifest = records.map(r => ({ runId:r.runId,taskId:r.taskId,mode:r.mode,caseId:r.caseId,modelId:r.modelId,provider:r.provider,underlyingProvider:r.underlyingProvider,operation:r.operation,status:r.status,assetPath:r.output?.assetPath,sha256:r.output?.sha256,promptSha256:r.promptSha256,inputAssetHashes:r.inputAssetHashes,costUsd:r.billing.amountUsd,evidence:r.billing.evidence,printGate:r.output?.printGate }));
  await writeFile(path.join(reportDir,'manifest.csv'),csv(manifest,['runId','taskId','mode','caseId','modelId','provider','underlyingProvider','operation','status','assetPath','sha256','promptSha256','inputAssetHashes','costUsd','evidence','printGate']));
  const costs=live.map(r=>({runId:r.runId,providerRequestId:r.providerRequestId,modelId:r.modelId,operation:r.operation,status:r.status,amountUsd:r.billing.amountUsd,evidence:r.billing.evidence,reservedUsd:r.reservationUsd,invoiceReference:r.billing.invoiceReference,pricingSource:r.billing.pricingSource}));
  await writeFile(path.join(reportDir,'cost-reconciliation.csv'),csv(costs,['runId','providerRequestId','modelId','operation','status','amountUsd','evidence','reservedUsd','invoiceReference','pricingSource']));
  const modelIds=[...new Set(live.map(r=>r.modelId))];
  const leaderboard: Record<string,unknown>[]=[];
  for(const id of modelIds) for(const operation of ['concept','edit','final']) {
    const rows=live.filter(r=>r.modelId===id&&r.operation===operation); if(!rows.length)continue;
    const evaluations=rows.map(r=>{const mapping=mappings.find(m=>m.runId===r.runId);return {r,q:quality(scoreRows.filter(s=>s.sampleId===mapping?.sampleId),operation)};});
    const accepted=evaluations.filter(({r,q})=>r.status==='completed'&&q?.accepted).length;
    const known=rows.filter(r=>r.billing.amountUsd!==null).reduce((a,r)=>a+r.billing.amountUsd!,0);
    const missing=rows.filter(r=>r.billing.amountUsd===null).length;
    const latency=rows.filter(r=>r.status==='completed'&&r.latencyMs!==null).map(r=>r.latencyMs!);
    const scores=evaluations.flatMap(e=>e.q?[e.q.median]:[]);
    leaderboard.push({modelId:id,operation,attempted:rows.length,completed:rows.filter(r=>r.status==='completed').length,
      accepted: evaluations.every(e=>e.q)?accepted:null,qualityMedian:percentile(scores,.5),qualityMin:scores.length?Math.min(...scores):null,qualityMax:scores.length?Math.max(...scores):null,
      maxInterRaterGap:Math.max(0,...evaluations.flatMap(e=>e.q?[e.q.gap]:[])),actualUsageUsd:known,unknownCharges:missing,
      costPerAcceptedUsd:accepted&& !missing ? known/accepted:null,p50Ms:percentile(latency,.5),p95Ms:percentile(latency,.95),
      failurePercent:100*rows.filter(r=>r.status==='failed').length/rows.length,unknownRequests:rows.filter(r=>['unknown','running'].includes(r.status)).length,
      printPass:evaluations.filter(({r,q})=>q?.physicalGateReviewed&&q.accepted&&r.output&&r.output.effectivePpi>=config.print.ppiTarget&&r.output.hasAlpha&&r.output.transparentPixelFraction>=.01).length,
      qualification:'PRELIMINARY: human scores, print confirmation and invoice reconciliation required'});
  }
  await writeFile(path.join(reportDir,'model-leaderboard.csv'),csv(leaderboard,['modelId','operation','attempted','completed','accepted','qualityMedian','qualityMin','qualityMax','maxInterRaterGap','actualUsageUsd','unknownCharges','costPerAcceptedUsd','p50Ms','p95Ms','failurePercent','unknownRequests','printPass','qualification']));
  const apiBaselines=modelIds.flatMap(modelId=>{
    const stageCost=(operation:string)=>{
      const rows=live.filter(r=>r.modelId===modelId&&r.operation===operation);
      const delivered=rows.filter(r=>r.status==='completed').length;
      return delivered && rows.every(r=>r.billing.amountUsd!==null) ? rows.reduce((sum,r)=>sum+r.billing.amountUsd!,0)/delivered : null;
    };
    const conceptUsd=stageCost('concept'),editUsd=stageCost('edit'),finalUsd=stageCost('final');
    if(conceptUsd===null||editUsd===null||finalUsd===null)return [];
    return [{modelId,conceptUsd,editUsd,finalUsd,apiOnlySessionUsd:3*conceptUsd+2*editUsd+finalUsd,
      acceptedSessionUsd:null,evidence:'Measured stage means; 3 concepts + 2 edits + tested final; excludes acceptance, cleanup, fees and production qualification'}];
  });
  await writeFile(path.join(reportDir,'api-session-baseline.csv'),csv(apiBaselines,['modelId','conceptUsd','editUsd','finalUsd','apiOnlySessionUsd','acceptedSessionUsd','evidence']));
  const usageUsd=live.reduce((a,r)=>a+(r.billing.amountUsd??0),0);
  const summary={generatedAt:new Date().toISOString(),experimentVersion:config.experimentVersion,liveAttempts:live.length,
    completed:live.filter(r=>r.status==='completed').length,failed:live.filter(r=>r.status==='failed').length,
    unresolved:live.filter(r=>['unknown','running'].includes(r.status)).length,usageUsd,
    invoiceConfirmedUsd:live.filter(r=>r.billing.evidence==='invoice').reduce((a,r)=>a+(r.billing.amountUsd??0),0),
    unknownCharges:live.filter(r=>r.billing.amountUsd===null).length,dryTasks:new Set(records.filter(r=>r.mode==='dry').map(r=>r.taskId)).size,
    reviewRows:scoreRows.length,modelsAttempted:modelIds.length,modelsCompared:new Set(live.filter(r=>r.status==='completed').map(r=>r.modelId)).size,modelWinners:null,creditPrices:null};
  await json(path.join(reportDir,'summary.json'),summary);
  await writeFile(path.join(reportDir,'raw-results.jsonl'),live.map(r=>JSON.stringify(r)).join('\n')+(live.length?'\n':''));
  // Economic simulator intentionally waits for qualified costs and fee assumptions.
  const simulator= [3,3.5,4].flatMap(multiplier=>['base','conservative','high-retry'].map(scenario=>({scenario,multiplier,
    costPerAcceptedDesignUsd:null,retailTargetUsd:null,creditDenominationUsd:null,minimumTopupUsd:5,redemptionRate:null,
    evidence:'N/A: accepted outputs, stage costs, payment fees and processing allocation pending'})));
  const assumptions=await optionalJson<EconomicsInput|null>(path.join(reportDir,'economics-assumptions.json'),null);
  if(assumptions){const modeled=simulate(assumptions);await writeFile(path.join(reportDir,'credit-simulator.csv'),csv(modeled,Object.keys(modeled[0])));}
  else await writeFile(path.join(reportDir,'credit-simulator.csv'),csv(simulator,['scenario','multiplier','costPerAcceptedDesignUsd','retailTargetUsd','creditDenominationUsd','minimumTopupUsd','redemptionRate','evidence']));
  console.log(JSON.stringify(summary));
  return summary;
}
