// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// The company/model catalog behind the new-chat provider picker. A chat is
// locked to one company for its whole life — the in-chat switcher only ever
// offers that company's own variants (see chatPanel.ts), never a different
// provider. That's deliberate: it keeps every swap within one tool-calling
// convention, one system-prompt format, one context window and pricing
// model, which is what made switching companies mid-task unreliable before
// (see modelRouter.ts's git history / the Aug 2026 portfolio-repo incident).
//
// ⚠️ THESE MODEL IDS AND PRICES GO STALE — periodically check
// https://openrouter.ai/models and update, same as freeModels.ts / pricing.ts.
export interface ModelVariant {
  id: string; // OpenRouter model id
  label: string; // shown in the switcher, e.g. "Sonnet 5"
  tagline: string; // one-line description shown under the label
  // Most current frontier models are multimodal; a handful of
  // open-weight/text-focused ones aren't. Defaults to true — only set
  // false explicitly where a variant genuinely can't see images, so a
  // clear error can be shown instead of a confusing raw API failure.
  vision?: boolean;
  // Whether the Effort switcher's choice (see chatPanel.ts) actually gets
  // sent to this variant, as OpenRouter's unified `reasoning.effort`
  // field (openrouter.ts). Defaults to true — every named model here
  // supports some form of adjustable reasoning (a literal effort enum,
  // or a thinking-token budget OpenRouter translates it into). Only the
  // Free provider's rotating, unpredictable underlying model sets this
  // false, so the field is never sent somewhere it might be rejected.
  reasoning?: boolean;
}

export interface Provider {
  id: string;
  label: string;
  // Ordered cheapest -> most capable. variants[0] is what a new chat with
  // this provider starts on — see defaultModelForProvider.
  variants: ModelVariant[];
}

export const PROVIDERS: Record<string, Provider> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    variants: [
      { id: 'anthropic/claude-haiku-4.5', label: 'Haiku 4.5', tagline: 'Fastest, for quick answers' },
      { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5', tagline: 'Most efficient for everyday tasks' },
      { id: 'anthropic/claude-opus-5', label: 'Opus 5', tagline: 'For complex tasks' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    variants: [
      { id: 'google/gemini-2.5-flash-lite', label: 'Flash Lite', tagline: 'Fastest, for quick answers' },
      { id: 'google/gemini-2.5-flash', label: 'Flash', tagline: 'Most efficient for everyday tasks' },
      { id: 'google/gemini-2.5-pro', label: 'Pro', tagline: 'For complex tasks' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    variants: [
      { id: 'openai/gpt-5-nano', label: 'GPT-5 Nano', tagline: 'Fastest, for quick answers' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', tagline: 'Most efficient for everyday tasks' },
      { id: 'openai/gpt-5', label: 'GPT-5', tagline: 'For complex tasks' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    variants: [
      { id: 'deepseek/deepseek-v3.2-exp', label: 'V3.2 Exp', tagline: 'Fastest, for quick answers', vision: false },
      { id: 'deepseek/deepseek-v3.2', label: 'V3.2', tagline: 'Most efficient for everyday tasks', vision: false },
      { id: 'deepseek/deepseek-r1', label: 'R1', tagline: 'For complex reasoning tasks', vision: false },
    ],
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    variants: [
      { id: 'moonshotai/kimi-k2-turbo', label: 'K2 Turbo', tagline: 'Fastest, for quick answers', vision: false },
      { id: 'moonshotai/kimi-k2', label: 'K2', tagline: 'Most efficient for everyday tasks', vision: false },
      { id: 'moonshotai/kimi-k2-thinking', label: 'K2 Thinking', tagline: 'For complex reasoning tasks', vision: false },
    ],
  },
  // Not a real company — routes through freeChainForTaskType's fallback
  // chain (see chatPanel.ts's callModel) rather than calling this id
  // directly. One entry so the picker/switcher UI can treat it uniformly
  // with every other provider.
  free: {
    id: 'free',
    label: 'Free',
    variants: [
      { id: 'openrouter/free', label: 'Auto', tagline: 'Best available free model, no cost', vision: false, reasoning: false },
    ],
  },
};

export const PROVIDER_ORDER = ['claude', 'gemini', 'openai', 'deepseek', 'kimi', 'free'];

export function defaultModelForProvider(providerId: string): string {
  return PROVIDERS[providerId]?.variants[0]?.id ?? PROVIDERS.free.variants[0].id;
}

// The smart-starting-variant pick — same company defaultModelForProvider
// would've picked, but at the tier estimateStartingTier's heuristic
// thinks the thread's first message actually needs, clamped to however
// many variants this company actually has (Free has just the one).
// Never called past a thread's first message — see
// complexityEstimator.ts's own comment for why that boundary matters.
export function startingModelForProvider(providerId: string, tier: number): string {
  const variants = PROVIDERS[providerId]?.variants ?? PROVIDERS.free.variants;
  const clamped = Math.min(tier, variants.length - 1);
  return variants[clamped]?.id ?? variants[0].id;
}

export function isValidProviderModel(providerId: string, modelId: string): boolean {
  return !!PROVIDERS[providerId]?.variants.some((v) => v.id === modelId);
}

export function findVariant(providerId: string, modelId: string): ModelVariant | undefined {
  return PROVIDERS[providerId]?.variants.find((v) => v.id === modelId);
}

export function supportsReasoning(providerId: string, modelId: string): boolean {
  return findVariant(providerId, modelId)?.reasoning !== false;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = 'medium';

// Effort auto-suggestion's tier -> level mapping (Roadmap Priority 3, see
// chatPanel.ts's handleSend). Deliberately the same 0/1/2 tier
// complexityEstimator.ts's estimateStartingTier already produces for Smart
// Starting Variant, not a second classifier — reasoning depth needed and
// model strength needed correlate on the same signals (code blocks, stack
// traces, "refactor the whole thing" phrasing), so one heuristic serves
// both call sites. EFFORT_LEVELS has exactly 3 entries, one per tier, so
// this is really just an array index with a defensive clamp.
export function effortForTier(tier: number): EffortLevel {
  return EFFORT_LEVELS[Math.min(Math.max(tier, 0), EFFORT_LEVELS.length - 1)];
}
