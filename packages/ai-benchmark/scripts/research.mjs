import { mkdir, writeFile } from 'node:fs/promises';
const dir = new URL('../data/research/', import.meta.url);
await mkdir(dir, { recursive: true });
async function snapshot(name, url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const data = await response.json();
  await writeFile(new URL(`${name}.json`, dir), JSON.stringify({ accessedAt: new Date().toISOString(), url, data }, null, 2));
  return data;
}
const catalog = await snapshot('openrouter-image-models', 'https://openrouter.ai/api/v1/images/models');
const ids = ['google/gemini-nano-banana-2.1','openai/gpt-image-2.5-sunburst','black-forest-labs/flux-3-image','recraft/recraft-v4.1-flash','bytedance-seed/seedream-5-0-flash'];
for (const id of ids) {
  if (!catalog.data.some(m => m.id === id)) { console.log(`${id}: NOT IN CATALOG`); continue; }
  try {
    const data = await snapshot(id.replaceAll('/', '__'), `https://openrouter.ai/api/v1/images/models/${id}/endpoints`);
    console.log(JSON.stringify(data));
  } catch (e) { console.log(String(e)); }
}
