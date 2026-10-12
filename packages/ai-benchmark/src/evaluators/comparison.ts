export interface Score {
  sampleId: string; reviewerId: string; originality: number; moodboard: number;
  editPreservation: number; printSuitability: number; accepted: boolean;
  ipPass: boolean; edgesPass: boolean; genuineTransparency: boolean; notes: string;
}
export function validateScores(rows: Score[], sampleIds: string[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!sampleIds.includes(row.sampleId) || !/^[\w-]{1,50}$/.test(row.reviewerId)) throw new Error('Unknown sample or invalid reviewer ID');
    for (const metric of ['originality','moodboard','editPreservation','printSuitability'] as const) {
      if (!Number.isInteger(row[metric]) || row[metric] < 1 || row[metric] > 5) throw new Error('Scores must be integers 1-5');
    }
    for (const field of ['accepted','ipPass','edgesPass','genuineTransparency'] as const) if (typeof row[field] !== 'boolean') throw new Error(`Missing boolean ${field}`);
    if (typeof row.notes !== 'string' || row.notes.length > 3000) throw new Error('Invalid score notes');
    const key = `${row.sampleId}|${row.reviewerId}`;
    if (seen.has(key)) throw new Error('Duplicate reviewer/sample'); seen.add(key);
  }
}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b); const index = (sorted.length - 1) * p;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
export function quality(scores: Score[], operation: string) {
  if (scores.length < 2 || new Set(scores.map(s => s.reviewerId)).size < 2) return null;
  // Edit preservation is not observable in a concept-only sample. Renormalize its 20% out.
  const weights = operation === 'edit' ? [25,20,20,20] : [25,20,0,20];
  const values = scores.map(s => (s.originality*weights[0] + s.moodboard*weights[1] + s.editPreservation*weights[2] + s.printSuitability*weights[3]) / weights.reduce((a,b)=>a+b,0));
  const gap = Math.max(...values) - Math.min(...values);
  return { median: percentile(values, 0.5)!, min: Math.min(...values), max: Math.max(...values), gap,
    accepted: scores.every(s => s.accepted && s.ipPass) && gap <= 1,
    physicalGateReviewed: scores.every(s => s.edgesPass && s.genuineTransparency) };
}
