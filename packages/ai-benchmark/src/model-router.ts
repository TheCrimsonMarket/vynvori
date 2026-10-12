import type { Model, Task } from './types.js';
export function validateRequest(model: Model, task: Task, referenceCount: number) {
  if (!model.operations.includes(task.operation)) throw new Error('Unsupported operation');
  if (model.rightsStatus !== 'reviewed-research') throw new Error('Rights/access review incomplete');
  if (task.operation !== 'concept' && referenceCount < 1) throw new Error('Edit/final requires original source image');
  if (referenceCount) {
    const cap = model.capabilities.input_references;
    if (!cap || referenceCount > (cap.max ?? 0) || referenceCount < (cap.min ?? 0)) throw new Error('Unsupported reference count');
  }
  for (const [key, value] of Object.entries(task.requested)) {
    const cap = model.capabilities[key];
    if (!cap) throw new Error(`Unsupported parameter: ${key}`);
    if (cap.type === 'enum' && !cap.values?.includes(String(value))) throw new Error(`Unsupported ${key}: ${value}`);
    if (cap.type === 'range' && (typeof value !== 'number' || !Number.isInteger(value) || value < (cap.min ?? 0) || value > (cap.max ?? Infinity))) throw new Error(`Invalid ${key}`);
  }
}
export class ModelRouter {
  constructor(private models: Model[]) {}
  resolve(task: Task) {
    const model = this.models.find(m => m.id === task.modelId);
    if (!model) throw new Error(`No configured exact model: ${task.modelId}`);
    return model;
  }
}
