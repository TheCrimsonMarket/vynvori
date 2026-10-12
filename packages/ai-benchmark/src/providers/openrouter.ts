import type { Adapter, Model, Task, ProviderResult } from '../types.js';
import { ProviderError, responseJson } from './http.js';
export class OpenRouterAdapter implements Adapter {
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
  async generate(model: Model, task: Task, prompt: string, references: string[], signal: AbortSignal,
    onSubmitted: (id: string) => Promise<void>): Promise<ProviderResult> {
    const response = await this.fetcher('https://openrouter.ai/api/v1/images', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'X-Title': 'Vynvori benchmark' },
      body: JSON.stringify({ model: model.id, prompt, ...task.requested,
        input_references: references.map(url => ({ type: 'image_url', image_url: { url } })),
        provider: { only: [model.providerTag], allow_fallbacks: false } })
    });
    const requestId = response.headers.get('x-request-id');
    if (requestId) await onSubmitted(requestId);
    const data = await responseJson(response);
    if (!Array.isArray(data.data) || data.data.length !== 1 || typeof data.data[0].b64_json !== 'string') throw new ProviderError('INVALID_IMAGE_RESPONSE', true);
    const encoded = data.data[0].b64_json;
    if (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 70_000_000) throw new ProviderError('INVALID_IMAGE_BYTES', true);
    const amount = data.usage?.cost;
    return { bytes: Buffer.from(encoded, 'base64'), requestId: requestId ?? data.id ?? null,
      amountUsd: typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null,
      usage: data.usage ?? null, warnings: [] };
  }
}
export interface KeyStatus { limit: number | null; limit_remaining: number | null; limit_reset: string | null; usage: number; is_free_tier: boolean }
export async function checkKey(key: string, fetcher: typeof fetch = fetch): Promise<KeyStatus> {
  const response = await fetcher('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000)
  });
  const raw = (await responseJson(response)).data;
  // Explicit allowlist: never persist key label/hash/account information.
  return { limit: raw.limit ?? null, limit_remaining: raw.limit_remaining ?? null,
    limit_reset: raw.limit_reset ?? null, usage: raw.usage, is_free_tier: raw.is_free_tier };
}
export function enforceKeyCap(status: KeyStatus, ceiling: number, reservation: number) {
  if (status.is_free_tier || !Number.isFinite(status.usage)) throw new Error('Funded key and usage evidence required');
  if (status.limit == null || !Number.isFinite(status.limit) || status.limit > ceiling || status.limit_reset != null) throw new Error(`Dedicated lifetime key limit must be at most $${ceiling}, with no periodic reset`);
  if (status.limit_remaining == null || !Number.isFinite(status.limit_remaining) || status.limit_remaining < reservation) throw new Error('Key remaining budget cannot reserve this request');
}
