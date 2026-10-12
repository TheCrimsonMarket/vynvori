import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { csv, json, loadEvents, readJson, root, sha256 } from './io.js';
import type { Brief, Config, Model, Task } from './types.js';
export async function prepare() {
  const history=await loadEvents<{mode:string;attempts:number}>();
  if(history.some(r=>r.mode==='live'&&r.attempts>0))throw new Error('Prepare cannot overwrite an experiment with paid requests; use a new experiment directory');
  const ids = ['google/gemini-nano-banana-2.1', 'openai/gpt-image-2.5-sunburst', 'black-forest-labs/flux-3-image', 'bytedance-seed/seedream-5-0-flash'];
  const terms: Record<string, string[]> = {
    google: ['https://ai.google.dev/gemini-api/terms'],
    openai: ['https://openai.com/policies/services-agreement/'],
    'black-forest-labs': ['https://bfl.ai/legal/terms-of-service'],
    'bytedance-seed': ['https://docs.byteplus.com/en/docs/legal/docs-service-specific-terms?TimeBefore=1785490519']
  };
  const models: Model[] = [];
  for (const id of ids) {
    const snapshot = await readJson<any>(path.join(root, 'data/research', id.replaceAll('/', '__') + '.json'));
    const endpoint = snapshot.data.endpoints[0];
    const isOpenAI = id.startsWith('openai/');
    const standard = isOpenAI ? { aspect_ratio: '1:1', quality: 'medium', n: 1 } : { aspect_ratio: '1:1', resolution: '1K', n: 1 };
    const final = isOpenAI ? { aspect_ratio: '3:4', quality: 'high', background: 'transparent', n: 1 } : { aspect_ratio: '3:4', resolution: '2K', n: 1 };
    models.push({ id, gateway: 'openrouter', providerTag: endpoint.provider_tag, operations: ['concept','edit','final'],
      capabilities: endpoint.supported_parameters, pricingSource: snapshot.url, pricingVersion: snapshot.accessedAt,
      pricing: endpoint.pricing, reservationUsd: { concept: 0.30, edit: 0.40, final: 0.80 },
      defaults: { concept: standard, edit: standard, final }, rightsStatus: 'reviewed-research',
      rightsSources: ['https://openrouter.ai/terms', ...terms[id.split('/')[0]]] });
  }
  models.push({ id: 'fal-ai/ideogram/v3', gateway: 'fal', providerTag: 'ideogram', operations: ['concept'],
    capabilities: { image_size: { type: 'enum', values: ['square_hd'] }, rendering_speed: { type: 'enum', values: ['BALANCED','QUALITY','TURBO'] },
      num_images: { type: 'range', min: 1, max: 1 }, input_references: { type: 'range', min: 0, max: 3 } },
    pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.06, variant: 'BALANCED' }],
    pricingSource: 'https://fal.ai/models/fal-ai/ideogram/v3', pricingVersion: '2026-10-12',
    reservationUsd: { concept: 0.1, edit: 0, final: 0 },
    defaults: { concept: { image_size: 'square_hd', rendering_speed: 'BALANCED', num_images: 1 }, edit: {}, final: {} },
    rightsStatus: 'reviewed-research', rightsSources: ['https://fal.ai/models/fal-ai/ideogram/v3'] });
  await json(path.join(root, 'config/models.json'), models);
  await json(path.join(root, 'data/model-manifest.json'), models);
  const config: Config = { experimentVersion: 'v1-screen-2026-10-12', globalCapUsd: 10, overheadReserveUsd: 0.5,
    providerCapsUsd: { openrouter: 9.5, fal: 0 }, stageCapsUsd: { concept: 5.0, edit: 2, final: 2 },
    authorizedModels: ids, concurrency: 1, timeoutMs: 240000, retries: 0,
    print: { widthMm: 300, heightMm: 400, ppiTarget: 300, method: 'DTF-provisional', confirmed: false } };
  await json(path.join(root, 'config/benchmark.json'), config);
  const common = 'Create original standalone artwork for a black oversized streetwear T-shirt. Artwork only, no shirt photograph, mockup, seams, shadows, watermark, logo, recognizable game character or text. Strong silhouette, intentional negative space, clean edges, high visibility on black fabric. Treat references as abstract direction, never copy their arrangement. Leave the surrounding background flat black.';
  const cases = [
    ['ARPG-01', 'An original cartographer emblem: a fractured compass, winding portal-map routes and a small lantern; dark fantasy etched linework.', ['#e9dbb5','#b27cff','#4bcabb'], 'exploration, maps, portals', 'engraved poster graphic', 'I’m only mapping.'],
    ['MIN-02', 'A restrained gothic industrial sigil built from three offset arches and one broken ring. Sparse geometry, generous negative space, no ornate clutter.', ['#e9e9df','#a484ff','#b9b9be'], 'architecture, restraint, machinery', 'minimal vector-like geometry', ''],
    ['CHAR-03', 'An original small lantern courier creature with two short asymmetrical horns, wide bell-shaped cloak, three visible toes and a floating diamond lantern; friendly yet mysterious. Full silhouette.', ['#f1deb2','#8563c8','#59bdba'], 'courier, lantern, exploration', 'bold character illustration', ''],
    ['MOOD-04', 'An original psychedelic fantasy motif synthesizing palette, portal geometry and organic contours from the three references into a new arrangement: branching crystal fronds spiralling around a crescent portal.', ['#edb0f7','#8d67dc','#53d9c3'], 'portal, crystals, organic rhythm', 'psychedelic fantasy screenprint', '']
  ] as const;
  const licenses: Record<string, unknown>[] = [];
  for (const [caseId, intent, palette, symbolism, artDirection, text] of cases) {
    const referenceNames: string[] = [];
    for (let index = 0; index < 3; index++) {
      const name = `${caseId}-${index + 1}.png`;
      const shapes = index === 0 ? palette.map((color, j) => `<rect x="${j * 170}" y="0" width="170" height="512" fill="${color}"/>`).join('')
        : index === 1 ? `<path d="M110 400 L110 220 Q256 20 402 220 L402 400 M150 400 L150 240 Q256 80 362 240 L362 400" fill="none" stroke="${palette[1]}" stroke-width="18"/><circle cx="256" cy="290" r="80" fill="none" stroke="${palette[0]}" stroke-width="12"/>`
        : `<path d="M256 80 Q390 180 320 265 Q425 355 256 425 Q95 350 190 265 Q120 175 256 80Z" fill="${palette[2]}"/><path d="M256 110 Q320 240 256 390" fill="none" stroke="${palette[0]}" stroke-width="14"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#101014"/>${shapes}</svg>`;
      const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      const target = path.join(root, 'fixtures/references', name);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
      licenses.push({ file: name, source: 'Original procedural artwork: src/prepare.ts', rights: 'Internally created for Vynvori benchmark; no external assets', sha256: sha256(bytes), width: 512, height: 512, constraints: 'Abstract visual direction only; not a real licensed-image moodboard test' });
      referenceNames.push(name);
    }
    const brief: Brief = { caseId, version: 'v1', intent, palette: [...palette], symbolism, artDirection,
      exclusions: ['third-party IP','logos','watermarks','garment mockups','raster typography'], garment: 'black oversized/drop-shoulder T-shirt', zone: 'front', outputFormat: 'png-or-native-raster',
      corePrompt: `${common} ${intent} Palette: ${palette.join(', ')}. Art direction: ${artDirection}.`,
      refinements: ['Change only the purple accent areas to amber (#e3aa50); preserve all shapes, position, proportions and other colors.',
        'Add a small four-point star within the top-right negative space only; preserve the central silhouette, identity, palette and all other regions.'],
      references: referenceNames, ...(text ? { typography: { text, placement: 'separate editable centered caption beneath artwork' } } : {}) };
    await json(path.join(root, 'fixtures/briefs', `${caseId}.json`), brief);
  }
  await writeFile(path.join(root, 'fixtures/references/LICENSES.csv'), csv(licenses, ['file','source','rights','sha256','width','height','constraints']));
  const tasks: Task[] = [];
  // Round-robin across models and cases: each family sees identical reference bytes and core prompt.
  for (const [caseId] of cases) for (const model of models.filter(m => ids.includes(m.id))) {
    tasks.push({ taskId: sha256(`${config.experimentVersion}|${caseId}|${model.id}|concept|1`).slice(0,24), caseId, trial: 1,
      modelId: model.id, operation: 'concept', requested: model.defaults.concept });
  }
  await json(path.join(root, 'config/concepts.json'), tasks);
  await json(path.join(root, 'config/selections.example.json'), {
    instructions: 'After blind concept review, select source task IDs for two models on CHAR-03. CLI followups creates two controlled edits per model and one final per model (6 attempts). No automatic winner.',
    sourceTaskIds: tasks.filter(t => t.caseId === 'CHAR-03').slice(0,2).map(t => t.taskId)
  });
  console.log(JSON.stringify({ prepared: true, conceptTasks: tasks.length, referenceImages: licenses.length, globalCapUsd: 10, falCapUsd: 0 }));
}
