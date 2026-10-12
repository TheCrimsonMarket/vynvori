import test from 'node:test';import assert from 'node:assert/strict';
import {simulate} from '../src/economics.js';
test('3x retail markup may lose money after a fixed payment fee and redemption',()=>{
  const input={conceptUsd:.01,editUsd:.01,standardFinalUsd:.03,premiumFinalUsd:.06,promptAndStorageUsd:0,processingAndSupportUsd:0,paymentRate:.03,paymentFixedUsd:.30,fundingFeeRate:0,creditUnitUsd:.01,redemptionUsd:.10};
  const rows=simulate(input);assert.equal(rows.length,18);
  const base=rows.find(r=>r.tier==='standard'&&r.scenario==='base'&&r.multiplier===3)!;
  assert.ok(Math.abs(base.apiSessionUsd-.08)<1e-9);assert.equal(base.credits,24);assert.equal(base.requiredTopupUsd,5);assert.equal(base.boundaryPermitted,false);assert.ok(base.contributionUsd<0);
  const retry=rows.find(r=>r.tier==='premium'&&r.retryFactor===2&&r.multiplier===4)!;assert.ok(retry.apiSessionUsd>base.apiSessionUsd*2);
});
test('no undefined cost, invalid denomination, or payment rate may produce a proposal',()=>{
  assert.throws(()=>simulate({} as any),/Invalid economics/);
  const input={conceptUsd:1,editUsd:1,standardFinalUsd:1,premiumFinalUsd:2,promptAndStorageUsd:0,processingAndSupportUsd:0,paymentRate:1,paymentFixedUsd:0,fundingFeeRate:0,creditUnitUsd:.01,redemptionUsd:0};
  assert.throws(()=>simulate(input),/Invalid payment/);assert.throws(()=>simulate({...input,paymentRate:.03,creditUnitUsd:0}));
});
