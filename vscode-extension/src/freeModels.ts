import { TaskType } from './modelRouter';

// Ported from the original chai.agent server.js project's models.config.js.
// ⚠️ THESE MODEL IDS GO STALE — periodically check
// https://openrouter.ai/models?max_price=0 and update.
// Only two buckets (coding/general) — free-tier availability is coarser
// than the paid 3-tier split, so low+medium collapse into "general" here.
export const FREE_MODELS = {
  coding: [
    'poolside/laguna-s-2.1:free',
    'poolside/laguna-xs-2.1:free',
    'cohere/north-mini-code:free',
  ],
  general: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'openai/gpt-oss-20b:free',
  ],
  fallback: 'openrouter/free', // always answers — last resort
};

export function freeChainForTaskType(taskType: TaskType): string[] {
  const ranked = taskType === 'coding' ? FREE_MODELS.coding : FREE_MODELS.general;
  return [...ranked, FREE_MODELS.fallback];
}
