import test from 'node:test';import assert from 'node:assert/strict';
import { execute } from '../src/runner.js';import { validateRequest } from '../src/model-router.js';
import { setup, memoryLedger, imageBytes } from './helpers.js';
test('dry-run is offline and makes zero provider calls',async()=>{
  const {models,config,task,briefs}=await setup();const ledger=memoryLedger();let calls=0;
  const rows=await execute([task],models,briefs,config,'dry',{...ledger,adapter:{generate:async()=>{calls++;throw new Error('must not call');}}});
  assert.equal(calls,0);assert.equal(rows[0].status,'dry-run');assert.equal(rows[0].billing.amountUsd,null);assert.equal(rows[0].attempts,0);assert.equal(rows[0].inputAssetHashes.length,3);
});
test('unsupported capabilities rejected before any POST',async()=>{
  const {models,task}=await setup();assert.throws(()=>validateRequest(models[0],{...task,requested:{background:'transparent'}},3),/Unsupported parameter/);
  assert.throws(()=>validateRequest(models[0],task,15),/reference count/);assert.throws(()=>validateRequest(models[0],{...task,operation:'edit'},0),/source image/);
});
test('missing billing preserves output but blocks subsequent work',async()=>{
  const {models,config,task,briefs}=await setup();const ledger=memoryLedger();let calls=0;
  const deps={...ledger,adapter:{generate:async()=>{calls++;return{bytes:await imageBytes(),requestId:'known-job',amountUsd:null,usage:null,warnings:[]};}},beforePaid:async()=>{},save:async()=>'/fake'};
  await assert.rejects(()=>execute([task,{...task,taskId:'next'}],models,briefs,config,'live',deps),/unknown/);assert.equal(calls,1);
  const row=(await ledger.records())[0];assert.ok(row.output?.sha256);assert.equal(row.providerRequestId,'known-job');assert.equal(row.billing.evidence,'estimate');
});
test('image save failure retains known charge and fails without retry',async()=>{
  const {models,config,task,briefs}=await setup();const ledger=memoryLedger();let calls=0;
  await assert.rejects(()=>execute([task],models,briefs,config,'live',{...ledger,adapter:{generate:async()=>{calls++;return{bytes:await imageBytes(),requestId:'r',amountUsd:.04,usage:{cost:.04},warnings:[]};}},beforePaid:async()=>{},save:async()=>{throw new Error('disk full');}}),/failed/);
  assert.equal(calls,1);const row=(await ledger.records())[0];assert.equal(row.billing.amountUsd,.04);assert.equal(row.status,'failed');
});
