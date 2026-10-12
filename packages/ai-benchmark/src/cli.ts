import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './prepare.js';
import { execute } from './runner.js';
import { exportReport } from './report.js';
import { validateScores } from './evaluators/comparison.js';
import type { Score } from './evaluators/comparison.js';
import type { BlindMapping } from './report.js';
import { event, json, latest, loadEvents, readJson, root, results, sha256 } from './io.js';
import { validateRequest } from './model-router.js';
import { validateConfig } from './cost-meter.js';
import { checkKey, enforceKeyCap } from './providers/openrouter.js';
import type { Brief, Config, Model, RunRecord, Task } from './types.js';
import { simulate } from './economics.js';
import type { EconomicsInput } from './economics.js';
import { csv } from './io.js';
const value = (args: string[], name: string) => args[args.indexOf(name) + 1];
async function preflight(models: Model[], tasks: Task[], briefs: Brief[], config: Config) {
  validateConfig(config);
  for(const task of tasks) {
    const model=models.find(m=>m.id===task.modelId); const brief=briefs.find(b=>b.caseId===task.caseId);
    if(!model||!brief)throw new Error('Unknown model or case');
    if(!config.authorizedModels.includes(model.id))throw new Error('Unauthorized model');
    validateRequest(model,task,task.operation==='concept'?brief.references.length:1);
    if(model.gateway!=='openrouter')throw new Error('fal budget is zero; paid use not authorized');
  }
  const key=process.env.OPENROUTER_API_KEY;
  if(!key)throw new Error('Set OPENROUTER_API_KEY locally in .env');
  const status=await checkKey(key);enforceKeyCap(status,config.providerCapsUsd.openrouter,Math.max(...tasks.map(t=>models.find(m=>m.id===t.modelId)!.reservationUsd[t.operation]),0));
  await json(path.join(results,'private/key-status-latest.json'),status);
  for(const model of models.filter(m=>tasks.some(t=>t.modelId===m.id))) {
    const response=await fetch(model.pricingSource,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Live endpoint catalog unavailable; no paid request sent');
    const catalog=await response.json();
    const endpoint=catalog.endpoints?.find((e:any)=>e.provider_tag===model.providerTag);
    if(!endpoint||JSON.stringify(endpoint.supported_parameters)!==JSON.stringify(model.capabilities)||JSON.stringify(endpoint.pricing)!==JSON.stringify(model.pricing))throw new Error('Provider capabilities/pricing changed; review and refresh manifest');
    await json(path.join(results,'private',model.id.replaceAll('/','__')+'-preflight.json'),{accessedAt:new Date().toISOString(),source:model.pricingSource,catalog});
  }
  console.log(JSON.stringify({preflight:'passed',keyLimitUsd:status.limit,keyRemainingUsd:status.limit_remaining,requestsPlanned:tasks.length}));
}
export async function main(args=process.argv.slice(2)) {
  const command=args[0]??'dry-run';
  if(command==='prepare'){await prepare();return;}
  if(command==='export'){await exportReport();return;}
  if(command==='economics'){
    if(!args[1])throw new Error('Provide an economics assumptions JSON file with qualified costs');
    const input=await readJson<EconomicsInput>(path.resolve(args[1]));const rows=simulate(input);
    await json(path.join(results,'report/economics-assumptions.json'),input);
    await writeFile(path.join(results,'report/credit-simulator.csv'),csv(rows,Object.keys(rows[0])));
    console.log(JSON.stringify({scenarioRows:rows.length,evidence:'user-supplied costs and assumptions; verify qualifications'}));return;
  }
  if(command==='check-key'){
    if(!process.env.OPENROUTER_API_KEY)throw new Error('OPENROUTER_API_KEY is not set locally');
    const config=await readJson<Config>(path.join(root,'config/benchmark.json'));
    const status=await checkKey(process.env.OPENROUTER_API_KEY);
    console.log(JSON.stringify({configured:true,limitUsd:status.limit,remainingUsd:status.limit_remaining,usageUsd:status.usage,reset:status.limit_reset}));
    enforceKeyCap(status,config.providerCapsUsd.openrouter,0);
    await json(path.join(results,'private/key-status-latest.json'),status);
    return;
  }
  if(command==='scores'){
    const input=args[1];if(!input)throw new Error('Provide a reviewer JSON file');
    const rows=await readJson<Score[]>(path.resolve(input));
    const mappings=await readJson<BlindMapping[]>(path.join(results,'private/blind-map.json'));
    validateScores(rows,mappings.map(m=>m.sampleId));
    let current:Score[]=[];try{current=await readJson<Score[]>(path.join(results,'report/scores.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    validateScores([...current,...rows],mappings.map(m=>m.sampleId));
    await json(path.join(results,'report/scores.json'),[...current,...rows]);await exportReport();return;
  }
  if(command==='reconcile'){
    const reconciliation=await readJson<any>(path.resolve(args[1]??''));
    const all=latest(await loadEvents<RunRecord>());const r=all.find(r=>r.runId===reconciliation.runId&&r.mode==='live');
    if(!r||!['running','unknown','completed','failed'].includes(r.status))throw new Error('Only submitted live requests can be reconciled');
    if(!['completed','failed'].includes(reconciliation.status)||!['invoice','usage'].includes(reconciliation.evidence)||!Number.isFinite(reconciliation.amountUsd)||reconciliation.amountUsd<0||typeof reconciliation.reference!=='string'||!reconciliation.reference.trim())throw new Error('Provide verified status, nonnegative charge and evidence reference');
    if(reconciliation.status==='completed'&&!r.output)throw new Error('Cannot complete a request without a verified durable artifact');
    if(['completed','failed'].includes(r.status)&&reconciliation.status!==r.status)throw new Error('Billing reconciliation cannot change a confirmed delivery outcome');
    r.status=reconciliation.status;r.billing={...r.billing,amountUsd:reconciliation.amountUsd,evidence:reconciliation.evidence,invoiceReference:reconciliation.reference};r.endedAt=new Date().toISOString();
    await event(r);await exportReport();return;
  }
  const models=await readJson<Model[]>(path.join(root,'config/models.json'));
  const config=await readJson<Config>(path.join(root,'config/benchmark.json'));
  const briefs=await Promise.all((await readdir(path.join(root,'fixtures/briefs'))).filter(f=>f.endsWith('.json')).map(f=>readJson<Brief>(path.join(root,'fixtures/briefs',f))));
  if(command==='followups'){
    const selection=await readJson<{sourceTaskIds:string[];modelIds?:string[]}>(path.resolve(args[1]??path.join(root,'config/selections.example.json')));
    if(!selection.sourceTaskIds.length||selection.sourceTaskIds.length>4||new Set(selection.sourceTaskIds).size!==selection.sourceTaskIds.length)throw new Error('Select one to four distinct concept tasks');
    const concepts=await readJson<Task[]>(path.join(root,'config/concepts.json'));const tasks:Task[]=[];
    for(const id of selection.sourceTaskIds){const source=concepts.find(t=>t.taskId===id);if(!source||source.caseId!=='CHAR-03')throw new Error('Followups require CHAR-03 concepts');
      for(const modelId of selection.modelIds??[source.modelId]) {
      const model=models.find(m=>m.id===modelId);if(!model||!config.authorizedModels.includes(model.id))throw new Error('Unauthorized followup model');
      for(const index of [0,1])tasks.push({taskId:sha256(`${config.experimentVersion}|${id}|${model.id}|edit|${index}`).slice(0,24),caseId:source.caseId,trial:1,modelId:model.id,operation:'edit',editTest:index,sourceTaskId:id,requested:model.defaults.edit});
      tasks.push({taskId:sha256(`${config.experimentVersion}|${id}|${model.id}|final`).slice(0,24),caseId:source.caseId,trial:1,modelId:model.id,operation:'final',sourceTaskId:id,requested:model.defaults.final});
      }
    }
    await json(path.join(root,'config/followups.json'),tasks);console.log(JSON.stringify({followupTasks:tasks.length}));return;
  }
  if(!['dry-run','run'].includes(command))throw new Error('Commands: prepare, dry-run, check-key, run --live [--stage smoke|concept|followups], followups selections.json, scores review.json, reconcile evidence.json, export');
  const live=command==='run'&&args.includes('--live');
  const stage=args.includes('--stage')?value(args,'--stage'):'concept';
  if(!['smoke','concept','followups'].includes(stage))throw new Error('Invalid stage');
  let tasks=await readJson<Task[]>(path.join(root,`config/${stage==='followups'?'followups':'concepts'}.json`));
  if(stage==='smoke')tasks=tasks.filter(t=>t.caseId==='ARPG-01');
  if(args.includes('--only-model'))tasks=tasks.filter(t=>t.modelId===value(args,'--only-model'));
  if(args.includes('--exclude-model'))tasks=tasks.filter(t=>t.modelId!==value(args,'--exclude-model'));
  await mkdir(results,{recursive:true});
  const lock=path.join(results,'.runner.lock');const handle=await open(lock,'wx');
  try{
    await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    if(live){
      const history=latest(await loadEvents<RunRecord>());
      if(history.some(r=>r.mode==='live'&&['running','unknown'].includes(r.status)))throw new Error('Reconcile outstanding request before resume');
      tasks=tasks.filter(t=>{
        const prior=history.filter(r=>r.mode==='live'&&r.taskId===t.taskId&&r.attempts>0);
        return !prior.length || (args.includes('--retry-rejected')&&prior.length===1&&prior[0].status==='failed'&&prior[0].errorCode==='HTTP_429'&&prior[0].billing.amountUsd===0);
      });
      if(!tasks.length){console.log('All tasks already attempted; no paid requests sent');return;}
      await preflight(models,tasks,briefs,config);
    }
    await json(path.join(results,'runs',`manifest-${Date.now()}.json`),{mode:live?'live':'dry',stage,config,configSha256:sha256(JSON.stringify(config)),models,tasks,startedAt:new Date().toISOString()});
    await execute(tasks,models,briefs,config,live?'live':'dry',{allowRejectedRetry:args.includes('--retry-rejected')});
  }finally{await handle.close();await unlink(lock);await exportReport();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  // Errors from our own validation are safe; never stringify provider bodies or HTTP request objects.
  console.error(error instanceof Error?error.message:'Benchmark failed');process.exitCode=1;
});
