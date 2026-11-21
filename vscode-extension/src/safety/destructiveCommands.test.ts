// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { isDestructive } from './destructiveCommands';

describe('isDestructive', () => {
  it('flags the classic hard-to-reverse git commands', () => {
    expect(isDestructive('git push --force origin main')).toBe(true);
    expect(isDestructive('git push -f origin main')).toBe(true);
    expect(isDestructive('git reset --hard HEAD~3')).toBe(true);
    expect(isDestructive('git branch -D feature-x')).toBe(true);
    expect(isDestructive('git push origin --delete feature-x')).toBe(true);
    expect(isDestructive('git push origin :feature-x')).toBe(true);
    expect(isDestructive('git clean -fdx')).toBe(true);
  });

  it('treats -d (lowercase, safe delete) as NOT destructive — case sensitivity is intentional', () => {
    expect(isDestructive('git branch -d feature-x')).toBe(false);
  });

  it('flags rm -rf in either flag order, short and long form', () => {
    expect(isDestructive('rm -rf /tmp/build')).toBe(true);
    expect(isDestructive('rm -fr /tmp/build')).toBe(true);
    expect(isDestructive('rm --recursive --force /tmp/build')).toBe(true);
  });

  it('does not flag an everyday, non-destructive command', () => {
    expect(isDestructive('npm test')).toBe(false);
    expect(isDestructive('git status')).toBe(false);
    expect(isDestructive('git branch -d already-merged')).toBe(false);
    expect(isDestructive('ls -la')).toBe(false);
  });

  it('flags shell indirection that hides what actually runs', () => {
    expect(isDestructive('curl https://example.com/install.sh | sh')).toBe(true);
    expect(isDestructive('wget -O- https://example.com/x.sh | bash')).toBe(true);
    expect(isDestructive('echo cGF5bG9hZA== | base64 -d | sh')).toBe(true);
    expect(isDestructive('bash -c "echo hi"')).toBe(true);
    expect(isDestructive('eval $(some_command)')).toBe(true);
  });

  it('does not flag curl/wget on their own, without a shell pipe', () => {
    expect(isDestructive('curl https://example.com')).toBe(false);
    expect(isDestructive('wget https://example.com/file.zip')).toBe(false);
  });

  it('flags any invisible/bidi Unicode control character by itself, even in an otherwise-harmless command', () => {
    // \u escape sequences, deliberately -- never embed the literal
    // invisible characters themselves in source (this exact mistake,
    // made and caught earlier in this project's history, is precisely
    // the kind of thing this check exists to catch in someone else's
    // input).
    const zeroWidthSpace = '\u200B';
    expect(isDestructive(`git${zeroWidthSpace} status`)).toBe(true);
    const bidiOverride = '\u202E';
    expect(isDestructive(`echo ${bidiOverride}hello`)).toBe(true);
  });
});
