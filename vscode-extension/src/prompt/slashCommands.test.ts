// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { expandSlashCommand } from './slashCommands';

describe('expandSlashCommand', () => {
  it('returns null for plain text with no leading slash', () => {
    expect(expandSlashCommand('please commit my changes')).toBeNull();
  });

  it('returns null for an unrecognized slash command (falls back to literal text)', () => {
    expect(expandSlashCommand('/notarealcommand do something')).toBeNull();
  });

  it('expands /commit into a canned Git Hygiene prompt', () => {
    const result = expandSlashCommand('/commit');
    expect(result).not.toBeNull();
    expect(result).toContain('/commit —');
    expect(result).toMatch(/git status|git diff/);
  });

  it('expands /review and /test similarly', () => {
    expect(expandSlashCommand('/review')).toContain('/review —');
    expect(expandSlashCommand('/test')).toContain('/test —');
  });

  it('is case-insensitive on the command name', () => {
    expect(expandSlashCommand('/COMMIT')).toContain('/commit —');
  });

  it('folds extra text after the command name into the expansion as additional context', () => {
    const result = expandSlashCommand('/commit only the auth module changes');
    expect(result).toContain('Additional context: only the auth module changes');
  });

  it('omits the additional-context line entirely when nothing follows the command', () => {
    const result = expandSlashCommand('/test')!;
    expect(result).not.toContain('Additional context:');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(expandSlashCommand('   /review   ')).toContain('/review —');
  });
});
