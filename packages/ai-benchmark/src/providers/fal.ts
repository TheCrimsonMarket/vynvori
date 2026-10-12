import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter, Model, Task, ProviderResult } from '../types.js';
import { getArtifact, ProviderError, responseJson } from './http.js';
export class FalAdapter implements Adapter {
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
  async generate(model: Model, task: Task, prompt: string, references: string[], signal: AbortSignal,
    onSubmitted: (id: string) => Promise<void>): Promise<ProviderResult> {
    // This adapter deliberately supports the researched Ideogram v3 concept contract only.
    if (model.id !== 'fal-ai/ideogram/v3' || task.operation !== 'concept') throw new Error('Unverified fal endpoint contract');
    const headers = { Authorization: `Key ${this.key}`, 'Content-Type': 'application/json' };
    const submit = await responseJson(await this.fetcher(`https://queue.fal.run/${model.id}`, {
      method: 'POST', headers, signal, body: JSON.stringify({ prompt, ...task.requested,
        image_urls: references, expand_prompt: false })
    }));
    if (typeof submit.request_id !== 'string') throw new ProviderError('MISSING_JOB_ID', true);
    await onSubmitted(submit.request_id);
    const base = `https://queue.fal.run/fal-ai/ideogram/requests/${encodeURIComponent(submit.request_id)}`;
    for (;;) {
      const state = await responseJson(await this.fetcher(`${base}/status`, { headers, signal }));
      if (state.status === 'COMPLETED') break;
      if (!['IN_QUEUE','IN_PROGRESS'].includes(state.status)) throw new ProviderError('FAL_JOB_UNKNOWN', true);
      await delay(1500, undefined, { signal });
    }
    const result = await responseJson(await this.fetcher(base, { headers, signal }));
    if (result.images?.length !== 1 || typeof result.images[0].url !== 'string') throw new ProviderError('INVALID_IMAGE_RESPONSE', true);
    return { bytes: await getArtifact(result.images[0].url, signal, this.fetcher), requestId: submit.request_id,
      amountUsd: null, usage: null, warnings: ['fal cost requires usage export / invoice reconciliation'] };
  }
}
