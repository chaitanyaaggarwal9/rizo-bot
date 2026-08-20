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
    // 2026-08-20: kimi-k2-turbo was pulled from OpenRouter entirely
    // (real users hit "not a valid model ID" on it) — replaced this
    // whole lineup with what's actually live now rather than patch just
    // the one dead id, since k2/k2-thinking had also drifted close
    // enough in price ($0.57/$2.30 vs $0.60/$2.50) to barely function as
    // separate tiers anymore. k2.5 and k3 both gained image input since
    // the old lineup was set up.
    variants: [
      { id: 'moonshotai/kimi-k2.5', label: 'K2.5', tagline: 'Fastest, for quick answers' },
      { id: 'moonshotai/kimi-k2-thinking', label: 'K2 Thinking', tagline: 'Most efficient for everyday tasks', vision: false },
      { id: 'moonshotai/kimi-k3', label: 'K3', tagline: 'For complex reasoning tasks' },
    ],
  },
  // Not a real company, and these 6 variants aren't tiers of one lineage
  // the way every other provider's are — free-tier availability on
  // OpenRouter comes from a different, shifting set of companies
  // entirely (no free Claude or Gemini exists), so there's no honest
  // "cheapest → strongest" ladder to build here. variants[0] (Auto)
  // stays the default and is what defaultModelForProvider/
  // startingModelForProvider fall back to; chatPanel.ts's handleSend
  // explicitly excludes 'free' from Smart Starting Variant's auto-
  // upgrade for exactly this reason — a 0/1/2 tier has nothing coherent
  // to map onto 5 unrelated specific picks, so it stays fully manual.
  // Auto's own routing (callModel, freeChainForTaskType) is unchanged;
  // picking one of the 5 named models tries it first, then still falls
  // back through the same taskType-ranked chain if it's down or rate-
  // limited — an explicit pick doesn't lose Auto's resilience.
  free: {
    id: 'free',
    label: 'Free',
    variants: [
      { id: 'openrouter/free', label: 'Auto', tagline: 'Best model for the task, picked automatically', vision: false, reasoning: false },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'NVIDIA Nemotron Ultra', tagline: 'Largest free model, 1M-token context', vision: false },
      { id: 'openai/gpt-oss-20b:free', label: 'OpenAI GPT-OSS 20B', tagline: "OpenAI's open-weight model", vision: false },
      { id: 'google/gemma-4-31b-it:free', label: 'Google Gemma 4', tagline: 'Supports image input', vision: true },
      { id: 'cohere/north-mini-code:free', label: 'Cohere North Mini', tagline: 'Tuned for coding tasks', vision: false },
      { id: 'z-ai/glm-5.2:free', label: 'Z.ai GLM 5.2', tagline: 'General-purpose, 256K context', vision: false },
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
