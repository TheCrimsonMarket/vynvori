import test from 'node:test';import assert from 'node:assert/strict';
import { micros, reserve } from '../src/cost-meter.js';
import { execute } from '../src/runner.js';
import { setup, memoryLedger, imageBytes } from './helpers.js';
test('exact USD arithmetic and cap boundaries fail closed',async()=>{
  const {models,config,task}=await setup();assert.equal(micros(.1+.2),300000);assert.throws(()=>micros(NaN));
  reserve(config,[],models[0],task);assert.throws(()=>reserve({...config,globalCapUsd:1.1,overheadReserveUsd:1},[],models[0],task));
  assert.throws(()=>reserve({...config,providerCapsUsd:{openrouter:.1,fal:0}},[],models[0],task));
  assert.throws(()=>reserve({...config,stageCapsUsd:{concept:.1,edit:2,final:2}},[],models[0],task));
  assert.throws(()=>reserve({...config,authorizedModels:[]},[],models[0],task));
});
test('completed and failed paid tasks cannot be charged a second time',async()=>{
  const {models,config,task,briefs}=await setup();const ledger=memoryLedger();let posts=0;
  const adapter={generate:async()=>{posts++;return{bytes:await imageBytes(),requestId:'r',amountUsd:.03,usage:{cost:.03},warnings:[]};}};
  const deps={...ledger,adapter,beforePaid:async()=>{},save:async()=>'/fake'};
  await execute([task],models,briefs,config,'live',deps);
  await assert.rejects(()=>execute([task],models,briefs,config,'live',deps),/already attempted/);assert.equal(posts,1);
});
test('outstanding unknown liability prevents any further request',async()=>{
  const {models,config,task,briefs}=await setup();const ledger=memoryLedger();let posts=0;
  const deps={...ledger,adapter:{generate:async()=>{posts++;throw new Error('network timeout');}},beforePaid:async()=>{}};
  await assert.rejects(()=>execute([task],models,briefs,config,'live',deps),/unknown/);
  const history=await ledger.records();assert.equal(history[0].status,'unknown');assert.equal(history[0].attempts,1);assert.equal(history[0].billing.amountUsd,null);
  await assert.rejects(()=>execute([{...task,taskId:'next'}],models,briefs,config,'live',deps),/Reconcile/);assert.equal(posts,1);
});
