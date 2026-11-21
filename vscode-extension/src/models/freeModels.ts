// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { TaskType } from '../routing/modelRouter';

// Refresh these picks now and then from
// https://openrouter.ai/models?max_price=0 (the live catalog already
// skips any that disappear).
// Only two buckets (coding/general) — free-tier availability is coarser
// than the paid 3-tier split, so low+medium collapse into "general" here.
export const FREE_MODELS = {
  // Tried in order before the always-answers fallback. Current free models
  // that support tool calls, ranked for each kind of task.
  coding: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'inclusionai/ling-3.2-flash:free',
    'nvidia/nemotron-3.5-super-vl:free',
  ],
  general: [
    'nvidia/nemotron-3.5-super-vl:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
  ],
  fallback: 'openrouter/free', // always answers — last resort
};

// How many named free models to try before the fallback.
const CHAIN_LENGTH = 3;

// The ranked list above, minus any model the live catalog says is gone
// or no longer supports tools, topped up with the newest other free
// tool-capable models. Without a catalog (offline), the static list.
export function freeChainForTaskType(
  taskType: TaskType,
  catalog?: ReadonlyMap<string, { id: string; tools: boolean; created: number }>,
): string[] {
  const ranked = taskType === 'coding' ? FREE_MODELS.coding : FREE_MODELS.general;
  if (!catalog) return [...ranked, FREE_MODELS.fallback];
  const usable = (id: string) => !!catalog.get(id)?.tools;
  const chain = ranked.filter(usable);
  const extras = [...catalog.values()]
    .filter((m) => m.tools && m.id.endsWith(':free') && !chain.includes(m.id))
    .sort((a, b) => b.created - a.created)
    .map((m) => m.id);
  for (const id of extras) {
    if (chain.length >= CHAIN_LENGTH) break;
    chain.push(id);
  }
  return [...chain, FREE_MODELS.fallback];
}
