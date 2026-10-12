import test from 'node:test';import assert from 'node:assert/strict';
import { inspect } from '../src/evaluators/technical.js';import { quality, percentile, validateScores } from '../src/evaluators/comparison.js';
import { setup, imageBytes } from './helpers.js';import type { Score } from '../src/evaluators/comparison.js';
test('native pixels determine PPI; metadata DPI cannot rescue low resolution',async()=>{
  const {config}=await setup();const output=await inspect(await imageBytes(),'a.png',config.print);
  assert.equal(output.width,256);assert.ok(output.effectivePpi<17);assert.equal(output.transparentPixelFraction,0);assert.ok(output.printGate.startsWith('FAIL'));
});
test('no ranking or accepted count before two reviewers',()=>{
  const row:Score={sampleId:'S-a',reviewerId:'r1',originality:5,moodboard:4,editPreservation:3,printSuitability:4,accepted:true,ipPass:true,edgesPass:true,genuineTransparency:true,notes:''};
  assert.equal(quality([row],'concept'),null);validateScores([row],['S-a']);
  assert.throws(()=>validateScores([row,row],['S-a']),/Duplicate/);
  const scored=quality([row,{...row,reviewerId:'r2'}],'edit');assert.ok(scored?.accepted);assert.equal(percentile([10,30],.95),29);
  assert.throws(()=>validateScores([{...row,originality:6}],['S-a']));
});
