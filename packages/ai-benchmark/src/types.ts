export type Gateway = 'openrouter' | 'fal';
export type Operation = 'concept' | 'edit' | 'final';
export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'dry-run' | 'blocked';
export type Descriptor = { type: string; values?: string[]; min?: number; max?: number };
export interface Model {
  id: string; gateway: Gateway; providerTag: string; operations: Operation[];
  capabilities: Record<string, Descriptor>; pricingSource: string; pricingVersion: string;
  pricing: { billable: string; unit: string; cost_usd: number; variant?: string }[];
  reservationUsd: Record<Operation, number>; defaults: Record<Operation, Record<string, unknown>>;
  rightsStatus: 'reviewed-research' | 'unverified'; rightsSources: string[];
}
export interface Brief {
  caseId: string; version: string; intent: string; palette: string[]; symbolism: string;
  exclusions: string[]; artDirection: string; garment: string; zone: string;
  outputFormat: string; corePrompt: string; refinements: string[]; references: string[];
  typography?: { text: string; placement: string };
}
export interface Task {
  taskId: string; caseId: string; trial: number; modelId: string; operation: Operation;
  editTest?: number; sourceTaskId?: string; requested: Record<string, unknown>;
}
export interface Config {
  experimentVersion: string; globalCapUsd: number; overheadReserveUsd: number;
  providerCapsUsd: Record<Gateway, number>; stageCapsUsd: Record<Operation, number>;
  authorizedModels: string[]; concurrency: 1; timeoutMs: number; retries: 0;
  print: { widthMm: number; heightMm: number; ppiTarget: number; method: string; confirmed: boolean };
}
export interface Output {
  assetPath: string; sha256: string; width: number; height: number; format: string;
  hasAlpha: boolean; transparentPixelFraction: number; effectivePpi: number; printGate: string;
}
export interface RunRecord {
  runId: string; taskId: string; experimentVersion: string; mode: 'dry' | 'live';
  caseId: string; trial: number; provider: Gateway; underlyingProvider: string; modelId: string;
  operation: Operation; sourceRunId: string | null; briefVersion: string; startedAt: string;
  endedAt: string | null; promptSha256: string; authoredPrompt: string; sentPrompt: string;
  inputAssetHashes: string[]; requested: Record<string, unknown>; output: Output | null;
  latencyMs: number | null; attempts: number; status: Status; reservationUsd: number;
  billing: { amountUsd: number | null; evidence: 'invoice' | 'usage' | 'estimate' | 'none';
    pricingSource: string; pricingVersion: string; usage?: unknown; invoiceReference?: string };
  providerRequestId: string | null; correlationId: string; warnings: string[]; errorCode: string | null;
}
export interface ProviderResult { bytes: Buffer; requestId: string | null; amountUsd: number | null; usage: unknown; warnings: string[] }
export interface Adapter {
  generate(model: Model, task: Task, prompt: string, references: string[], signal: AbortSignal,
    onSubmitted: (requestId: string) => Promise<void>): Promise<ProviderResult>;
}
