// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { redactSecrets } from './outputRedaction';

describe('redactSecrets', () => {
  it('leaves ordinary command output untouched', () => {
    const text = 'total 24\ndrwxr-xr-x  5 user  staff  160 Aug 19 12:00 src';
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts this extension's own kind of key (OpenRouter)", () => {
    const text = 'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef0123456789';
    expect(redactSecrets(text)).toBe('OPENROUTER_API_KEY=[REDACTED]');
  });

  it('redacts an Anthropic key and a generic sk- key', () => {
    expect(redactSecrets('key=sk-ant-abcdefghijklmnop0123456789')).toBe('key=[REDACTED]');
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwx')).toBe('[REDACTED]');
  });

  it('redacts a GitHub token', () => {
    expect(redactSecrets('token: ghp_' + 'a'.repeat(36))).toBe('token: [REDACTED]');
  });

  it('redacts an AWS access key ID by its fixed shape, no label needed', () => {
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]');
  });

  it('redacts a labeled AWS secret access key but keeps the label', () => {
    const secret = 'a'.repeat(40);
    expect(redactSecrets(`aws_secret_access_key = ${secret}`)).toBe('aws_secret_access_key = [REDACTED]');
  });

  it('redacts a JWT without needing a label', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(`Authorization header: ${jwt}`)).toBe('Authorization header: [REDACTED]');
  });

  it('redacts a Bearer token but keeps the "Bearer " prefix', () => {
    expect(redactSecrets('Authorization: Bearer abcdef0123456789ABCDEF')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts a generic labeled secret (env dump style) but keeps the label', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2')).toBe('DB_PASSWORD=[REDACTED]');
    expect(redactSecrets('secret_token: "abcdef0123456789"')).toBe('secret_token: [REDACTED]');
  });

  it('does not touch a short value under a labeled key (avoids false positives on trivial config)', () => {
    expect(redactSecrets('TOKEN_TTL=3600')).toBe('TOKEN_TTL=3600');
  });

  it('redacts a whole PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\nabc123\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe('before\n[REDACTED]\nafter');
  });

  it('redacts multiple distinct secrets in the same blob', () => {
    const text = 'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef0123456789\nAWS_KEY=AKIAABCDEFGHIJKLMNOP';
    const result = redactSecrets(text);
    expect(result).not.toContain('sk-or-v1-');
    expect(result).not.toContain('AKIA');
    expect(result).toContain('OPENROUTER_API_KEY=[REDACTED]');
    expect(result).toContain('AWS_KEY=[REDACTED]');
  });
});
