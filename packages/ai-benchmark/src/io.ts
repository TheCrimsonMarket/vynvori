import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const root = path.resolve(import.meta.dirname, '..');
export const results = path.join(root, 'results');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')); }
export async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function event(record: unknown, file = path.join(results, 'runs', 'ledger.jsonl')) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + '\n', { flush: true });
}
export async function loadEvents<T>(file = path.join(results, 'runs', 'ledger.jsonl')): Promise<T[]> {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export function latest<T extends { runId: string }>(events: T[]): T[] {
  return [...new Map(events.map(e => [e.runId, e])).values()];
}
export function csv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+@\t\r]/.test(s) || /^-[^\d]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}
export function safePath(base: string, relative: string) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Path outside artifact directory');
  return resolved;
}
