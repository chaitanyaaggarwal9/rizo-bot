// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// The company/model catalog behind the new-chat provider picker. A chat is
// locked to one company for its whole life — the in-chat switcher only ever
// offers that company's own variants, never a different provider. Keeps
// every swap within one tool-calling convention, system-prompt format,
// context window, and pricing model.
//
// The variants here are the curated cheap → everyday → strongest ladder
// for each company. The model switcher's "More models" section adds the
// company's other current models from the live catalog (modelCatalog.ts),
// so new releases are usable without a Rizo update. Refresh these tiers
// now and then from https://openrouter.ai/models.
export interface ModelVariant {
  id: string; // OpenRouter model id
  label: string; // shown in the switcher, e.g. "Sonnet 5"
  tagline: string; // one-line description shown under the label
  // Most current frontier models are multimodal; a handful of
  // open-weight/text-focused ones aren't. Defaults to true — only set
  // false explicitly where a variant genuinely can't see images, so a
  // clear error can be shown instead of a confusing raw API failure.
  vision?: boolean;
  // Whether the Effort switcher's choice gets sent to this variant, as
  // OpenRouter's unified `reasoning.effort` field. Defaults to true.
  // Only Free's rotating, unpredictable underlying model sets this
  // false, so the field is never sent somewhere it might be rejected.
  reasoning?: boolean;
}

export interface Provider {
  id: string;
  label: string;
  // Which live-catalog models belong to this company: ids starting with
  // this ("anthropic/"), or for Free, ending with ":free".
  modelPrefix: string;
  // Ordered cheapest -> most capable. variants[0] is what a new chat with
  // this provider starts on — see defaultModelForProvider.
  variants: ModelVariant[];
}

export const PROVIDERS: Record<string, Provider> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    modelPrefix: 'anthropic/',
    variants: [
      { id: 'anthropic/claude-haiku-5.5', label: 'Haiku 5.5', tagline: 'Fastest, for quick answers' },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet 5.5', tagline: 'Most efficient for everyday tasks' },
      { id: 'anthropic/claude-fable-5.2', label: 'Fable 5.2', tagline: 'For complex tasks' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    modelPrefix: 'google/gemini-',
    variants: [
      { id: 'google/gemini-3.5-flash-lite', label: '3.5 Flash Lite', tagline: 'Fastest, for quick answers' },
      { id: 'google/gemini-3.8-flash', label: '3.8 Flash', tagline: 'Most efficient for everyday tasks' },
      { id: 'google/gemini-4-neon', label: 'Gemini 4 Neon', tagline: 'For complex tasks' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    modelPrefix: 'openai/',
    variants: [
      { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', tagline: 'Fastest, for quick answers' },
      { id: 'openai/gpt-6.2-sol', label: 'GPT-6.2 Sol', tagline: 'Most efficient for everyday tasks' },
      { id: 'openai/gpt-6.2-astra', label: 'GPT-6.2 Astra', tagline: 'For complex tasks' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    modelPrefix: 'deepseek/',
    variants: [
      { id: 'deepseek/deepseek-v4.1-flash', label: 'V4.1 Flash', tagline: 'Fastest, for quick answers' },
      { id: 'deepseek/deepseek-v4-pro', label: 'V4 Pro', tagline: 'Most efficient for everyday tasks', vision: false },
      { id: 'deepseek/deepseek-v4-pro-0813', label: 'V4 Pro (0813)', tagline: 'For complex reasoning tasks', vision: false },
    ],
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    modelPrefix: 'moonshotai/',
    variants: [
      { id: 'moonshotai/kimi-k2.6', label: 'K2.6', tagline: 'Fastest, for quick answers' },
      { id: 'moonshotai/kimi-k2.7-code', label: 'K2.7 Code', tagline: 'Tuned for coding, everyday tasks' },
      { id: 'moonshotai/kimi-k3.1-pro', label: 'K3.1 Pro', tagline: 'For complex reasoning tasks' },
    ],
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    modelPrefix: 'x-ai/',
    variants: [
      { id: 'x-ai/grok-4.3', label: 'Grok 4.3', tagline: 'Fast, with a 1M-token context' },
      { id: 'x-ai/grok-4.7', label: 'Grok 4.7', tagline: 'For complex tasks' },
    ],
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    modelPrefix: 'qwen/',
    variants: [
      { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', tagline: 'Fastest, for quick answers' },
      { id: 'qwen/qwen3.7-plus', label: 'Qwen3.7 Plus', tagline: 'Most efficient for everyday tasks' },
      { id: 'qwen/qwen4-max', label: 'Qwen4 Max', tagline: 'For complex tasks' },
    ],
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    modelPrefix: 'mistralai/',
    variants: [
      { id: 'mistralai/mistral-small-2603', label: 'Small', tagline: 'Fastest, for quick answers' },
      { id: 'mistralai/mistral-medium-3-5', label: 'Medium 3.5', tagline: 'Everyday tasks' },
      { id: 'mistralai/mistral-large-4-0', label: 'Large 4', tagline: 'For complex tasks' },
    ],
  },
  zai: {
    id: 'zai',
    label: 'Z.ai GLM',
    modelPrefix: 'z-ai/',
    variants: [
      { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', tagline: 'Fastest and cheapest' },
      { id: 'z-ai/glm-5.3', label: 'GLM 5.3', tagline: 'Most efficient for everyday tasks', vision: false },
      { id: 'z-ai/glm-5.3-prime', label: 'GLM 5.3 Prime', tagline: 'For complex tasks', vision: false },
    ],
  },
  // Not a real company — these variants aren't tiers of one lineage;
  // free-tier availability comes from a shifting set of companies, so
  // there's no honest cheapest→strongest ladder. variants[0] (Auto) stays
  // the default; Smart Starting Variant explicitly excludes 'free'.
  // Picking a named model tries it first, then still falls back through
  // the taskType-ranked chain (freeModels.ts) if it's down or rate-limited.
  // The live catalog adds any other free model that supports tools.
  free: {
    id: 'free',
    label: 'Free',
    modelPrefix: ':free',
    variants: [
      { id: 'openrouter/free', label: 'Auto', tagline: 'Best model for the task, picked automatically', vision: false, reasoning: false },
      { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'NVIDIA Nemotron 3.5 Super', tagline: 'Supports image input, 1M-token context' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'NVIDIA Nemotron Ultra', tagline: 'Largest free model', vision: false },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Google Gemma 4', tagline: 'Supports image input' },
      { id: 'inclusionai/ling-3.2-flash:free', label: 'inclusionAI Ling 3.2 Flash', tagline: 'Fast, 1M-token context' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'NVIDIA Nemotron 3.5 Lightning', tagline: 'Fastest free model', vision: false },
    ],
  },
};

export const PROVIDER_ORDER = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'mistral', 'zai', 'free'];

export function defaultModelForProvider(providerId: string): string {
  return PROVIDERS[providerId]?.variants[0]?.id ?? PROVIDERS.free.variants[0].id;
}

// Same company defaultModelForProvider would've picked, but at the tier
// estimateStartingTier's heuristic thinks the message needs, clamped to
// however many variants this company has. Never called past a thread's
// first message.
export function startingModelForProvider(providerId: string, tier: number): string {
  const variants = PROVIDERS[providerId]?.variants ?? PROVIDERS.free.variants;
  const clamped = Math.min(tier, variants.length - 1);
  return variants[clamped]?.id ?? variants[0].id;
}

// Whether a model id belongs to this company (by id shape only).
export function belongsToProvider(providerId: string, modelId: string): boolean {
  const p = PROVIDERS[providerId];
  if (!p || typeof modelId !== 'string' || modelId.endsWith(':batch')) return false;
  if (providerId === 'free') return modelId === 'openrouter/free' || modelId.endsWith(':free');
  return modelId.startsWith(p.modelPrefix) && !modelId.endsWith(':free');
}

// Live-catalog facts Rizo needs about a model it doesn't curate.
export interface CatalogFacts {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

// A model a chat on this provider may use: one of its curated variants, or
// (with the live catalog) any other model of the same company that
// supports tool calls. Chats stay locked to their company either way.
export function isValidProviderModel(
  providerId: string,
  modelId: string,
  catalog?: ReadonlyMap<string, CatalogFacts>,
): boolean {
  if (PROVIDERS[providerId]?.variants.some((v) => v.id === modelId)) return true;
  const facts = catalog?.get(modelId);
  return !!facts && facts.tools && belongsToProvider(providerId, modelId);
}

export function findVariant(providerId: string, modelId: string): ModelVariant | undefined {
  return PROVIDERS[providerId]?.variants.find((v) => v.id === modelId);
}

// Vision/reasoning for any model a chat may use: the curated flags, or the
// live catalog's for other models. Unknown means "assume yes", matching
// the curated defaults.
export function modelSupportsVision(providerId: string, modelId: string, catalog?: ReadonlyMap<string, CatalogFacts>): boolean {
  const v = findVariant(providerId, modelId);
  if (v) return v.vision !== false;
  return catalog?.get(modelId)?.vision ?? true;
}

export function supportsReasoning(providerId: string, modelId: string, catalog?: ReadonlyMap<string, CatalogFacts>): boolean {
  const v = findVariant(providerId, modelId);
  if (v) return v.reasoning !== false;
  return catalog?.get(modelId)?.reasoning ?? true;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = 'medium';

// Effort auto-suggestion's tier→level mapping. Reuses estimateStartingTier's
// 0/1/2 tier rather than a second classifier — reasoning depth needed and
// model strength needed correlate on the same signals. EFFORT_LEVELS has
// exactly 3 entries, one per tier, so this is an array index with a
// defensive clamp.
export function effortForTier(tier: number): EffortLevel {
  return EFFORT_LEVELS[Math.min(Math.max(tier, 0), EFFORT_LEVELS.length - 1)];
}
