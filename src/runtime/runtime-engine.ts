import type { RuntimeEngine } from './runtime-types';

let runtimeEngine: RuntimeEngine = 'legacy';

export function getRuntimeEngine(): RuntimeEngine {
  return runtimeEngine;
}

export function setRuntimeEngineForTesting(engine: RuntimeEngine): void {
  runtimeEngine = engine;
}

export function resetRuntimeEngineForTesting(): void {
  runtimeEngine = 'legacy';
}
