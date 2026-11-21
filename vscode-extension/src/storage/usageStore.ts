// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';

// Tracks spend across every thread and provider, independent of
// per-thread storage (threadStore.ts's sumThreadTokens/sumThreadCost
// cover just one conversation) — the running total the header always
// shows. Stored in globalState, not per-workspace, since it spans every
// project.
const USAGE_KEY = 'rizo.usage';

interface UsageRecord {
  day: string; // 'YYYY-MM-DD', local date — dayTokens resets when this changes
  dayTokens: number;
  month: string; // 'YYYY-MM', local date — monthCost resets when this changes
  monthCost: number;
}

function today(): { day: string; month: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}

// Applies the day/month rollover if the stored record is stale — every
// read/write checks "is this still today/this month" first, so no cron
// job or startup hook is needed.
function rolledOver(record: UsageRecord | undefined): UsageRecord {
  const { day, month } = today();
  if (!record) return { day, month, dayTokens: 0, monthCost: 0 };
  return {
    day,
    month,
    dayTokens: record.day === day ? record.dayTokens : 0,
    monthCost: record.month === month ? record.monthCost : 0,
  };
}

export function getUsage(context: vscode.ExtensionContext): { dayTokens: number; monthCost: number } {
  const record = rolledOver(context.globalState.get<UsageRecord>(USAGE_KEY));
  return { dayTokens: record.dayTokens, monthCost: record.monthCost };
}

// Called once per completed turn, after that turn's usage/cost is known —
// folds it into the running today/this-month totals. Returns the updated
// totals so the caller can push them straight to the webview without a
// separate read.
export function recordUsage(
  context: vscode.ExtensionContext,
  tokens: number,
  cost: number,
): { dayTokens: number; monthCost: number } {
  const record = rolledOver(context.globalState.get<UsageRecord>(USAGE_KEY));
  record.dayTokens += tokens;
  record.monthCost += cost;
  context.globalState.update(USAGE_KEY, record);
  return { dayTokens: record.dayTokens, monthCost: record.monthCost };
}
