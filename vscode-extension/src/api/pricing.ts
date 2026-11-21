// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Current OpenRouter pricing (per million tokens) for every variant listed
// in providers.ts. ⚠️ THESE GO STALE — periodically check against
// https://openrouter.ai/models and update.
export interface ModelPricing {
  promptPerM: number;
  completionPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude
  'anthropic/claude-haiku-4.5': { promptPerM: 0.25, completionPerM: 1.25 },
  'anthropic/claude-sonnet-5': { promptPerM: 2.0, completionPerM: 10.0 },
  'anthropic/claude-opus-5': { promptPerM: 12.0, completionPerM: 60.0 },
  // Gemini
  'google/gemini-2.5-flash-lite': { promptPerM: 0.1, completionPerM: 0.4 },
  'google/gemini-2.5-flash': { promptPerM: 0.3, completionPerM: 2.5 },
  'google/gemini-2.5-pro': { promptPerM: 1.25, completionPerM: 10.0 },
  // OpenAI
  'openai/gpt-5-nano': { promptPerM: 0.05, completionPerM: 0.4 },
  'openai/gpt-5-mini': { promptPerM: 0.25, completionPerM: 2.0 },
  'openai/gpt-5': { promptPerM: 1.25, completionPerM: 10.0 },
  // DeepSeek
  'deepseek/deepseek-v3.2-exp': { promptPerM: 0.14, completionPerM: 0.28 },
  'deepseek/deepseek-v3.2': { promptPerM: 0.27, completionPerM: 1.1 },
  'deepseek/deepseek-r1': { promptPerM: 0.55, completionPerM: 2.19 },
  // Kimi
  'moonshotai/kimi-k2.5': { promptPerM: 0.45, completionPerM: 2.25 },
  'moonshotai/kimi-k2-thinking': { promptPerM: 0.6, completionPerM: 2.5 },
  'moonshotai/kimi-k3': { promptPerM: 3.0, completionPerM: 15.0 },
};

// Free-tier models (":free" suffix, or OpenRouter's own free router) cost
// $0 by definition — no lookup needed. An unrecognized paid model (should
// not happen given our fixed provider catalog, but just in case) returns 0
// rather than guessing at a price.
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  if (model.endsWith(':free') || model === 'openrouter/free') return 0;
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.promptPerM + (completionTokens / 1_000_000) * pricing.completionPerM;
}
