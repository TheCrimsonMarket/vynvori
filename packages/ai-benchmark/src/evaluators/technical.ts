import sharp from 'sharp';
import type { Config, Output } from '../types.js';
import { sha256 } from '../io.js';
export async function inspect(bytes: Buffer, assetPath: string, print: Config['print']): Promise<Output> {
  const image = sharp(bytes, { limitInputPixels: 100_000_000 });
  const meta = await image.metadata();
  if (!meta.width || !meta.height || !['png','jpeg','webp','tiff'].includes(meta.format ?? '')) throw new Error('Unsupported raster artifact');
  const { data, info } = await sharp(bytes).resize({ width: 256, height: 256, fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] === 0) transparent++;
  const ppi = Math.min(meta.width / (print.widthMm / 25.4), meta.height / (print.heightMm / 25.4));
  const fraction = transparent / (info.width * info.height);
  const reasons = [];
  if (ppi < print.ppiTarget) reasons.push('insufficient-native-PPI-at-full-zone');
  if (!meta.hasAlpha || fraction < 0.01) reasons.push('no-meaningful-transparent-background');
  reasons.push('human-edge-color-IP-inspection-pending');
  if (!print.confirmed) reasons.push('printer-and-physical-sample-unconfirmed');
  return { assetPath, sha256: sha256(bytes), width: meta.width, height: meta.height, format: meta.format!,
    hasAlpha: !!meta.hasAlpha, transparentPixelFraction: fraction, effectivePpi: ppi,
    printGate: `${ppi < print.ppiTarget ? 'FAIL' : 'CONDITIONAL'}: ${reasons.join('; ')}` };
}
