// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { redactSecrets } from './outputRedaction';

// Fake AWS key IDs are assembled at runtime so the source never contains
// a key-shaped literal that secret scanners would report as a leak.
const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const FAKE_ASIA = 'ASIA' + 'ABCDEFGHIJKLMNOP';

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
    expect(redactSecrets(FAKE_AKIA)).toBe('[REDACTED]');
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
    const text = 'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef0123456789\nAWS_KEY=' + FAKE_AKIA + '';
    const result = redactSecrets(text);
    expect(result).not.toContain('sk-or-v1-');
    expect(result).not.toContain('AKIA');
    expect(result).toContain('OPENROUTER_API_KEY=[REDACTED]');
    expect(result).toContain('AWS_KEY=[REDACTED]');
  });

  it('redacts labelled secrets in JSON, YAML and quoted config', () => {
    expect(redactSecrets('{"api_key": "abcdef123456"}')).toBe('{"api_key": [REDACTED]}');
    expect(redactSecrets("password: 'p@ssw0rd!xyz'")).toBe('password: [REDACTED]');
    expect(redactSecrets('client_secret: s3cr3t-value')).toBe('client_secret: [REDACTED]');
  });

  it('redacts passwords containing symbols in full', () => {
    expect(redactSecrets('PASSWORD=p@ssw0rd!xyz')).toBe('PASSWORD=[REDACTED]');
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2!@#')).toBe('DB_PASSWORD=[REDACTED]');
    expect(redactSecrets('DB_PASS=short1')).toBe('DB_PASS=[REDACTED]');
  });

  it('redacts more labels', () => {
    for (const label of ['PRIVATE_KEY', 'ACCESS_KEY', 'CREDENTIALS', 'APIKEY', 'PASSPHRASE']) {
      expect(redactSecrets(`${label}=zxcvbnm123`)).toBe(`${label}=[REDACTED]`);
    }
  });

  it('redacts token formats that need no label', () => {
    const cases = [
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
      'sk-proj-abc_DEF-123456789012345678901234',
      'sk-svcacct-abcdefghijklmnopqrstuvwx',
      'sk_live_' + 'a'.repeat(24),
      'rk_test_' + 'b'.repeat(24),
      'xoxb-1234567890-abcdefghij',
      'AIza' + 'c'.repeat(35),
      FAKE_ASIA,
      'hf_' + 'd'.repeat(34),
      'npm_' + 'e'.repeat(36),
      'glpat-' + 'f'.repeat(20),
    ];
    for (const token of cases) {
      expect(redactSecrets(`value ${token} end`)).toBe('value [REDACTED] end');
    }
  });

  it('redacts all of an Anthropic key, including after underscores', () => {
    expect(redactSecrets('sk-ant-api03-AAAA_BBBB-CCCC_DDDD-EEEE')).toBe('[REDACTED]');
  });

  it('redacts credentials inside URLs but keeps the rest of the URL', () => {
    expect(redactSecrets('DATABASE_URL=postgres://app:hunter2@db.internal:5432/prod')).toBe(
      'DATABASE_URL=postgres://app:[REDACTED]@db.internal:5432/prod',
    );
    expect(redactSecrets('origin\thttps://me:ghtoken123@github.com/me/repo.git (fetch)')).toBe(
      'origin\thttps://me:[REDACTED]@github.com/me/repo.git (fetch)',
    );
    expect(redactSecrets('see https://github.com:443/me/repo')).toBe('see https://github.com:443/me/repo');
  });

  it('redacts Basic auth headers', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [REDACTED]');
  });

  it('redacts a private key block even without its END line, and other key types', () => {
    expect(redactSecrets('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA')).toBe('before\n[REDACTED]');
    expect(redactSecrets('-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----\nok')).toBe('[REDACTED]\nok');
    expect(redactSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----')).toBe('[REDACTED]');
  });

  it('leaves numbers, booleans and code references visible', () => {
    for (const text of [
      '"prompt_tokens": 512',
      'max_tokens=8192',
      'TOKEN_EXPIRY=true',
      'src/auth.ts:12:  const token = getToken();',
      'src/api.ts:40:  token: req.headers.authorization,',
      'password=$DB_PASS',
      'secret: ${SECRET_NAME}',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

