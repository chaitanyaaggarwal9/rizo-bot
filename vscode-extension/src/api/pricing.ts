// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// What a turn cost. OpenRouter reports the exact cost of each request
// (openrouter.ts asks for it), and that's used whenever it's present.
// Otherwise the live catalog's price is used, and this table is only the
// offline fallback for the curated tiers (USD per million tokens, from
// openrouter.ai/models on 2026-11-21).
export interface ModelPricing {
  promptPerM: number;
  completionPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-haiku-5.5': { promptPerM: 0.1, completionPerM: 0.5 },
  'anthropic/claude-sonnet-5.5': { promptPerM: 2.0, completionPerM: 10.0 },
  'anthropic/claude-fable-5.2': { promptPerM: 8.0, completionPerM: 40.0 },
  'openai/gpt-6-luna': { promptPerM: 0.1, completionPerM: 0.5 },
  'openai/gpt-6.2-sol': { promptPerM: 2.0, completionPerM: 10.0 },
  'openai/gpt-6.2-astra': { promptPerM: 8.0, completionPerM: 40.0 },
  'google/gemini-3.5-flash-lite': { promptPerM: 0.3, completionPerM: 2.5 },
  'google/gemini-3.8-flash': { promptPerM: 0.83, completionPerM: 4.12 },
  'google/gemini-4-neon': { promptPerM: 3.0, completionPerM: 15.0 },
  'deepseek/deepseek-v4.1-flash': { promptPerM: 0.05, completionPerM: 0.2 },
  'deepseek/deepseek-v4-pro': { promptPerM: 0.9, completionPerM: 1.5 },
  'deepseek/deepseek-v4-pro-0813': { promptPerM: 1.32, completionPerM: 3.96 },
  'moonshotai/kimi-k2.6': { promptPerM: 0.65, completionPerM: 3.41 },
  'moonshotai/kimi-k2.7-code': { promptPerM: 0.6, completionPerM: 3.0 },
  'moonshotai/kimi-k3.1-pro': { promptPerM: 0.25, completionPerM: 8.8 },
  'x-ai/grok-4.3': { promptPerM: 1.25, completionPerM: 2.5 },
  'x-ai/grok-4.7': { promptPerM: 2.0, completionPerM: 6.0 },
  'qwen/qwen3.8-flash': { promptPerM: 0.15, completionPerM: 0.47 },
  'qwen/qwen3.7-plus': { promptPerM: 0.32, completionPerM: 1.28 },
  'qwen/qwen4-max': { promptPerM: 1.42, completionPerM: 4.27 },
  'mistralai/mistral-small-2603': { promptPerM: 0.15, completionPerM: 0.6 },
  'mistralai/mistral-medium-3-5': { promptPerM: 1.5, completionPerM: 7.5 },
  'mistralai/mistral-large-4-0': { promptPerM: 0.7, completionPerM: 2.1 },
  'z-ai/glm-5.3-flash': { promptPerM: 0.04, completionPerM: 0.08 },
  'z-ai/glm-5.3': { promptPerM: 0.07, completionPerM: 1.4 },
  'z-ai/glm-5.3-prime': { promptPerM: 1.68, completionPerM: 5.28 },
};

// Free-tier models (":free" suffix, or OpenRouter's own free router) cost
// $0. A model with no known price returns 0 rather than guessing.
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  catalog?: ReadonlyMap<string, ModelPricing>,
): number {
  if (model.endsWith(':free') || model === 'openrouter/free') return 0;
  const pricing = catalog?.get(model) ?? PRICING[model];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.promptPerM + (completionTokens / 1_000_000) * pricing.completionPerM;
}
