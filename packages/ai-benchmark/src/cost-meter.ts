import type { Config, Model, RunRecord, Task } from './types.js';
export const micros = (usd: number) => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('Invalid USD amount');
  return Math.ceil(usd * 1_000_000 - 1e-8);
};
export function liability(r: RunRecord): number {
  if (r.mode !== 'live' || ['queued','blocked'].includes(r.status)) return 0;
  return r.billing.amountUsd ?? r.reservationUsd;
}
export function validateConfig(c: Config) {
  if (c.concurrency !== 1 || c.retries !== 0) throw new Error('Sequential/no-resubmit protocol required');
  for (const n of [c.globalCapUsd, c.overheadReserveUsd, ...Object.values(c.providerCapsUsd), ...Object.values(c.stageCapsUsd)]) micros(n);
  if (c.globalCapUsd > 10 || c.overheadReserveUsd >= c.globalCapUsd) throw new Error('Cap exceeds current authorization or invalid reserve');
}
export function reserve(c: Config, records: RunRecord[], model: Model, task: Task, allowRejectedRetry = false) {
  validateConfig(c);
  if (!c.authorizedModels.includes(model.id)) throw new Error('Model not authorized');
  if (records.some(r => r.mode === 'live' && ['running','unknown'].includes(r.status))) throw new Error('Reconcile unresolved paid request first');
  const previous = records.filter(r => r.mode === 'live' && r.taskId === task.taskId && r.attempts > 0);
  const safeRejectedRetry = allowRejectedRetry && previous.length === 1 && previous[0].status === 'failed' && previous[0].errorCode === 'HTTP_429' && previous[0].billing.amountUsd === 0;
  if (previous.length && !safeRejectedRetry) throw new Error('Task already attempted; no duplicate paid request');
  const planned = micros(model.reservationUsd[task.operation]);
  const sums = (filter: (r: RunRecord) => boolean) => records.filter(filter).reduce((a, r) => a + micros(liability(r)), 0);
  if (sums(() => true) + planned > micros(c.globalCapUsd - c.overheadReserveUsd)) throw new Error('Global spend reserve exceeded');
  if (sums(r => r.provider === model.gateway) + planned > micros(c.providerCapsUsd[model.gateway])) throw new Error('Provider cap exceeded');
  if (sums(r => r.operation === task.operation) + planned > micros(c.stageCapsUsd[task.operation])) throw new Error('Stage cap exceeded');
}
