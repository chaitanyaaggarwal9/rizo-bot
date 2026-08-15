// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Current OpenRouter pricing (per million tokens) for the models Rizo
// routes to. ⚠️ THESE GO STALE — periodically check against
// https://openrouter.ai/models and update.
export interface ModelPricing {
  promptPerM: number;
  completionPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-5': { promptPerM: 2.0, completionPerM: 10.0 },
  'google/gemini-2.5-flash': { promptPerM: 0.3, completionPerM: 2.5 },
  'openai/gpt-5-nano': { promptPerM: 0.05, completionPerM: 0.4 },
};

// Free-tier models (":free" suffix, or OpenRouter's own free router) cost
// $0 by definition — no lookup needed. An unrecognized paid model (should
// not happen given our fixed routing list, but just in case) returns 0
// rather than guessing at a price.
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  if (model.endsWith(':free') || model === 'openrouter/free') return 0;
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.promptPerM + (completionTokens / 1_000_000) * pricing.completionPerM;
}
