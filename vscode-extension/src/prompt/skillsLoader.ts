// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';
import type { TaskType } from '../routing/modelRouter';
import { BASE_SKILL, mentionsRizoLang, RIZOLANG_SKILL, SKILL_KEYWORDS, skillMatchCounts } from './skillKeywords';

// How many specialist skills load with the base skill. Each file is about
// 1-2 KB; capping keeps the system prompt small enough for small models.
export const MAX_SPECIALIST_SKILLS = 2;

// Short follow-ups ("ok, now add the tests") inherit the previous user
// message's specialists, at a lower weight than the message's own.
const FOLLOW_UP_MAX_WORDS = 12;

export interface SkillContext {
  // The workspace contains .rz files.
  rizoLangProject?: boolean;
}

// The base skill plus up to MAX_SPECIALIST_SKILLS specialists, ranked by
// how many of their keywords the message contains, plus the Rizo Lang spec
// when the chat involves Rizo Lang. Only for coding work.
export function selectSkillFiles(message: string, taskType: TaskType, previousUserMessage?: string, ctx: SkillContext = {}): string[] {
  if (taskType !== 'coding') return [];
  const scores = skillMatchCounts(message);
  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  const followUp = !!previousUserMessage && wordCount <= FOLLOW_UP_MAX_WORDS;
  if (previousUserMessage && followUp) {
    for (const [file, n] of skillMatchCounts(previousUserMessage)) {
      scores.set(file, (scores.get(file) ?? 0) + n * 0.5);
    }
  }
  const order = Object.keys(SKILL_KEYWORDS);
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([file]) => file)
    .slice(0, MAX_SPECIALIST_SKILLS);
  const rizoLang =
    ctx.rizoLangProject || mentionsRizoLang(message) || (followUp && mentionsRizoLang(previousUserMessage ?? ''));
  return rizoLang ? [BASE_SKILL, ...ranked, RIZOLANG_SKILL] : [BASE_SKILL, ...ranked];
}

// Reads the selected skill files fresh on every call (no caching) from the
// extension's own bundled skills/ directory.
export function loadSkillsContent(
  skillsDir: string,
  message: string,
  taskType: TaskType,
  previousUserMessage?: string,
  ctx: SkillContext = {},
): string {
  const files = selectSkillFiles(message, taskType, previousUserMessage, ctx);
  return files
    .map((file) => {
      try {
        return fs.readFileSync(path.join(skillsDir, file), 'utf-8');
      } catch (err: any) {
        console.warn(`Could not read skill file ${file}:`, err.message);
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}
