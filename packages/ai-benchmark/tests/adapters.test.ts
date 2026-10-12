import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterAdapter, enforceKeyCap } from '../src/providers/openrouter.js';
import { FalAdapter } from '../src/providers/fal.js';
import { ProviderError } from '../src/providers/http.js';
import { setup, imageBytes } from './helpers.js';
test('OpenRouter pins provider, disables fallback, sends identical reference input and captures charge',async()=>{
  const {models,task}=await setup();const bytes=await imageBytes();let request:any;let url:any;
  const adapter=new OpenRouterAdapter('not-a-real-key',(async(u,init)=>{url=u;request=JSON.parse(String(init?.body));return Response.json({data:[{b64_json:bytes.toString('base64')}],usage:{cost:.0336}},{headers:{'x-request-id':'request-123'}});}) as typeof fetch);
  const result=await adapter.generate(models[0],task,'same prompt',['data:image/png;base64,aaa'],AbortSignal.timeout(1000),async()=>{});
  assert.equal(url,'https://openrouter.ai/api/v1/images');assert.deepEqual(request.provider,{only:['google-ai-studio'],allow_fallbacks:false});assert.equal(request.prompt,'same prompt');assert.equal(request.input_references[0].image_url.url,'data:image/png;base64,aaa');assert.equal(result.amountUsd,.0336);assert.deepEqual(result.bytes,bytes);assert.equal(result.requestId,'request-123');
});
test('provider rejection bodies are not exposed and server errors remain ambiguous',async()=>{
  const {models,task}=await setup();const adapter=new OpenRouterAdapter('SECRET',(async()=>new Response('SECRET key and echoed prompt',{status:502})) as typeof fetch);
  await assert.rejects(()=>adapter.generate(models[0],task,'p',[],AbortSignal.timeout(1000),async()=>{}),(e:any)=>e instanceof ProviderError&&e.ambiguous&&!e.message.includes('SECRET'));
});
test('nonfinite reported charges are not trusted',async()=>{
  const {models,task}=await setup();const bytes=await imageBytes();const adapter=new OpenRouterAdapter('x',(async()=>Response.json({data:[{b64_json:bytes.toString('base64')}],usage:{cost:-1}})) as typeof fetch);
  const result=await adapter.generate(models[0],task,'p',[],AbortSignal.timeout(1000),async()=>{});assert.equal(result.amountUsd,null);
});
test('fal persists job ID before polling and never resubmits',async()=>{
  const {models}=await setup();const model=models.find(m=>m.gateway==='fal')!;const bytes=await imageBytes();let posts=0;let saved=false;const urls:string[]=[];
  const adapter=new FalAdapter('x',(async(url,init)=>{urls.push(String(url));if(init?.method==='POST'){posts++;return Response.json({request_id:'job-123'});}assert.equal(saved,true);if(String(url).endsWith('/status'))return Response.json({status:'COMPLETED'});return Response.json({images:[{url:'data:image/png;base64,'+bytes.toString('base64')}]});}) as typeof fetch);
  const result=await adapter.generate(model,{taskId:'x',caseId:'MIN-02',trial:1,modelId:model.id,operation:'concept',requested:model.defaults.concept},'p',[],AbortSignal.timeout(1000),async(id)=>{saved=id==='job-123';});
  assert.equal(posts,1);assert.equal(result.requestId,'job-123');assert.equal(result.amountUsd,null);assert.ok(urls[1].includes('/fal-ai/ideogram/requests/job-123/status'));
});
test('paid key preflight requires lifetime cap and sufficient balance',()=>{
  const status={limit:9,limit_remaining:9,limit_reset:null,usage:0,is_free_tier:false};
  enforceKeyCap(status,9,.8);
  assert.throws(()=>enforceKeyCap({...status,limit:9.5},9,.8));assert.throws(()=>enforceKeyCap({...status,limit_reset:'monthly'},9,.8));assert.throws(()=>enforceKeyCap({...status,limit_remaining:.1},9,.8));
});
