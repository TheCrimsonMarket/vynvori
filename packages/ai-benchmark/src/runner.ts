import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { reserve } from './cost-meter.js';
import { event, json, latest, loadEvents, results, root, safePath, sha256 } from './io.js';
import { ModelRouter, validateRequest } from './model-router.js';
import { inspect } from './evaluators/technical.js';
import { ProviderError } from './providers/http.js';
import { checkKey, enforceKeyCap, OpenRouterAdapter } from './providers/openrouter.js';
import { FalAdapter } from './providers/fal.js';
import type { Adapter, Brief, Config, Model, RunRecord, Task } from './types.js';
export interface RunnerDependencies {
  allowRejectedRetry?: boolean;
  adapter?: Adapter; beforePaid?: (model: Model, task: Task, reservation: number) => Promise<void>;
  persist?: (r: RunRecord) => Promise<void>; records?: () => Promise<RunRecord[]>;
  save?: (bytes: Buffer, runId: string) => Promise<string>;
}
export async function execute(tasks: Task[], models: Model[], briefs: Brief[], config: Config,
  mode: 'dry' | 'live' = 'dry', deps: RunnerDependencies = {}) {
  const router = new ModelRouter(models);
  const persist = deps.persist ?? event;
  const records = deps.records ?? (async () => latest(await loadEvents<RunRecord>()));
  const produced: RunRecord[] = [];
  for (const task of tasks) {
    const model = router.resolve(task);
    const brief = briefs.find(b => b.caseId === task.caseId);
    if (!brief) throw new Error('Missing versioned brief');
    let inputFiles: string[] = [];
    let sourceRunId: string | null = null;
    if (task.operation !== 'concept') {
      const source = (await records()).find(r => r.mode === mode && r.taskId === task.sourceTaskId && r.status === 'completed');
      if (!source?.output) {
        if (mode === 'live') throw new Error('Source task is not completed with a durable image');
      } else { inputFiles = [safePath(results, source.output.assetPath)]; sourceRunId = source.runId; }
    } else inputFiles = brief.references.map(name => safePath(path.join(root, 'fixtures/references'), name));
    const refs = await Promise.all(inputFiles.map(f => readFile(f)));
    const referenceData = await Promise.all(refs.map(async bytes => {
      const format = (await sharp(bytes).metadata()).format;
      if (!format || !['png','jpeg','webp'].includes(format)) throw new Error('Unsupported reference image format');
      return `data:image/${format};base64,${bytes.toString('base64')}`;
    }));
    const sentPrompt = task.operation === 'concept' ? brief.corePrompt
      : task.operation === 'edit' ? brief.refinements[task.editTest ?? 0]
      : 'Render the provided benchmark artwork at the requested higher quality. Preserve its identity, composition, palette and negative space. Artwork only; no shirt, mockup or text. Clean edges for a black garment.';
    const now = new Date().toISOString();
    const record: RunRecord = { runId: randomUUID(), taskId: task.taskId, experimentVersion: config.experimentVersion,
      mode, caseId: task.caseId, trial: task.trial, provider: model.gateway, underlyingProvider: model.providerTag,
      modelId: model.id, operation: task.operation, sourceRunId, briefVersion: brief.version,
      startedAt: now, endedAt: null, promptSha256: sha256(sentPrompt), authoredPrompt: sentPrompt, sentPrompt,
      inputAssetHashes: refs.map(sha256), requested: task.requested, output: null, latencyMs: null,
      attempts: 0, status: 'queued', reservationUsd: model.reservationUsd[task.operation],
      billing: { amountUsd: null, evidence: 'none', pricingSource: model.pricingSource, pricingVersion: model.pricingVersion },
      providerRequestId: null, correlationId: randomUUID(), warnings: [], errorCode: null };
    // Validate every task before the runner is called in live mode via CLI preflight as well.
    try {
      validateRequest(model, task, refs.length || (task.operation === 'concept' ? 0 : 1));
      if (mode === 'live') reserve(config, await records(), model, task, deps.allowRejectedRetry);
    } catch (e) {
      record.status = 'blocked'; record.errorCode = (e as Error).message; record.endedAt = now;
      await persist(record); produced.push(record);
      if (mode === 'live') throw e; else continue;
    }
    await persist(record);
    if (mode === 'dry') {
      record.status = 'dry-run'; record.endedAt = now; record.billing.evidence = 'none';
      record.warnings.push('No request sent; reservation is a planning allowance, not a price quote');
      await persist(record); produced.push(record); continue;
    }
    const key = model.gateway === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.FAL_KEY;
    if (!deps.adapter && !key) throw new Error(`Missing ${model.gateway} credential`);
    if (deps.beforePaid) await deps.beforePaid(model, task, record.reservationUsd);
    else if (model.gateway === 'openrouter') {
      const status = await checkKey(key!);
      enforceKeyCap(status, config.providerCapsUsd.openrouter, record.reservationUsd);
      await json(path.join(results, 'private/key-status-latest.json'), status);
    } else throw new Error('fal paid runs disabled: no funded account/budget approval');
    record.status = 'running'; record.attempts = 1;
    await persist(record); // flushed before POST: a crash leaves a blocking outstanding liability
    const started = Date.now();
    const adapter = deps.adapter ?? (model.gateway === 'openrouter' ? new OpenRouterAdapter(key!) : new FalAdapter(key!));
    try {
      const response = await adapter.generate(model, task, sentPrompt,
        referenceData, AbortSignal.timeout(config.timeoutMs),
        async requestId => { record.providerRequestId = requestId; await persist(record); });
      record.providerRequestId = response.requestId ?? record.providerRequestId;
      record.billing = { ...record.billing, amountUsd: response.amountUsd,
        evidence: response.amountUsd === null ? 'estimate' : 'usage', usage: response.usage };
      record.warnings.push(...response.warnings);
      await persist(record); // retain charge evidence even if image inspection or saving fails
      const relative = `artifacts/${record.runId}.bin`;
      const target = safePath(results, relative);
      // Persist exact provider bytes before decoding or inspection. Keep original metadata intact.
      if (deps.save) await deps.save(response.bytes, record.runId);
      else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, response.bytes, { flag: 'wx', flush: true }); }
      const output = await inspect(response.bytes, relative, config.print);
      if (!deps.save) {
        // Also write an extension-identified copy for viewers, while retaining the raw original.
        const readable = `artifacts/${record.runId}.${output.format === 'jpeg' ? 'jpg' : output.format}`;
        await writeFile(safePath(results, readable), response.bytes, { flag: 'wx', flush: true });
        output.assetPath = readable;
      }
      record.output = output; record.status = response.amountUsd === null ? 'unknown' : 'completed';
      if (response.amountUsd === null) record.warnings.push('Missing charge evidence: reconcile before further paid requests');
    } catch (e) {
      const providerError = e instanceof ProviderError ? e : new ProviderError('TRANSPORT_OR_ARTIFACT_ERROR', true);
      record.status = record.billing.amountUsd !== null ? 'failed' : providerError.ambiguous ? 'unknown' : 'failed';
      record.errorCode = providerError.code;
      if (providerError.confirmedZero) record.billing = { ...record.billing, amountUsd: 0, evidence: 'usage' };
    }
    record.endedAt = new Date().toISOString(); record.latencyMs = Date.now() - started;
    await persist(record); produced.push(record);
    console.log(JSON.stringify({ taskId: record.taskId, model: record.modelId, operation: record.operation, status: record.status, costUsd: record.billing.amountUsd }));
    if (record.status !== 'completed') throw new Error(`Stopped on ${record.status}: ${record.errorCode ?? 'reconciliation required'}`);
    if (record.billing.amountUsd! > record.reservationUsd) throw new Error('Actual cost exceeded planning allowance; inspect pricing before continuing');
  }
  return produced;
}
