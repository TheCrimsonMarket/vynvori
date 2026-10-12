export class ProviderError extends Error {
  constructor(public code: string, public ambiguous: boolean, public confirmedZero = false) { super(code); }
}
export async function responseJson(response: Response) {
  if (!response.ok) {
    // No upstream error bodies in logs: they can echo credentials or submitted data.
    const rejected = [400,401,402,403,404,422,429].includes(response.status);
    throw new ProviderError(`HTTP_${response.status}`, !rejected, rejected);
  }
  try { return await response.json(); } catch { throw new ProviderError('INVALID_RESPONSE', true); }
}
export async function getArtifact(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new ProviderError('INVALID_IMAGE_DATA', true);
    return Buffer.from(match[2], 'base64');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/(^|\.)(fal\.media|fal\.ai|fal\.run|googleapis\.com)$/.test(parsed.hostname)) throw new ProviderError('UNTRUSTED_ASSET_HOST', true);
  const response = await fetcher(url, { signal, redirect: 'error' });
  if (!response.ok) throw new ProviderError('ASSET_DOWNLOAD_FAILED', true);
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > 50_000_000) throw new ProviderError('ASSET_TOO_LARGE', true);
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('EMPTY_ASSET', true);
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 50_000_000) { await reader.cancel(); throw new ProviderError('ASSET_TOO_LARGE', true); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
