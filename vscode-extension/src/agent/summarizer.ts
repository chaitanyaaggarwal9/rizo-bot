// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Keeps long chats affordable: past SUMMARIZE_THRESHOLD messages, older
// turns are folded into a running summary that's sent instead of the full
// history. Only affects what's sent to the model, not what's stored or
// shown. planSummary is pure (tested in summarizer.test.ts); the call
// itself is made by the chat panel.

import type { ChatMessage, ContentPart } from '../api/openrouter';
import { PROVIDERS } from '../models/providers';

export const SUMMARY_MODEL = PROVIDERS.openai.variants[0].id;

// Threads longer than this stop replaying full raw history — everything
// older than the last SUMMARY_KEEP_TAIL folds into a running summary.
export const SUMMARIZE_THRESHOLD = 20;
export const SUMMARY_KEEP_TAIL = 10;

// Flattens stored/API message content down to plain text, for the
// summarizer prompt — an attached image becomes a plain marker since the
// summary itself never needs to carry the image data forward.
export function contentToPlainText(content: string | ContentPart[] | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image attached]'))
    .join(' ')
    .trim();
}

// What to fold and the prompt for it, or undefined when the thread isn't
// long enough yet.
export function planSummary(
  messages: { role: string; content: string | ContentPart[] | null | undefined }[],
  summarizedCount: number,
  priorSummary: string | undefined,
): { prompt: ChatMessage[]; foldEnd: number } | undefined {
  const total = messages.length;
  if (total - summarizedCount < SUMMARIZE_THRESHOLD) return undefined;
  const foldEnd = total - SUMMARY_KEEP_TAIL;
  const toFold = messages.slice(summarizedCount, foldEnd);
  if (toFold.length === 0) return undefined;
  const transcript = toFold.map((m) => `${m.role}: ${contentToPlainText(m.content)}`).join('\n\n');
  const prior = priorSummary ? `Existing summary so far:\n${priorSummary}\n\n` : '';
  return {
    foldEnd,
    prompt: [
      {
        role: 'system',
        content:
          'Summarize this conversation excerpt concisely for use as background context in a follow-up request. Preserve concrete facts, decisions, file names, and code details that matter; drop pleasantries. A short paragraph, not a list.',
      },
      { role: 'user', content: `${prior}New turns to fold in:\n\n${transcript}` },
    ],
  };
}
