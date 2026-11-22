// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { formatForModel, parseAuditOutput } from './auditOutput';

// Copied from the Rizo Lang README (0.6.0), the shape `--json` prints.
const ERRORS =
  '{"rizolang":"0.6.0","ok":false,"errors":[{"code":"RZ0318","message":"Endpoint \\"GET /posts\\" does not say who may call it.","fix":"Add `requires login` for logged-in users only, or `public` if anyone may call it.","file":"app.rz","line":14,"column":5,"length":3}]}';
const FINDINGS =
  '{"rizolang":"0.6.0","ok":false,"file":"app.rz","findings":[{"level":"warning","code":"RA01","message":"public write","fix":"add login","file":"app.rz","line":3,"column":1,"length":3},{"level":"note","code":"RA07","message":"a note","fix":"","file":"app.rz","line":null,"column":null,"length":null}],"summary":{"endpoints":4}}';

describe('parseAuditOutput', () => {
  it('reads compile errors', () => {
    const r = parseAuditOutput(ERRORS);
    expect(r).toEqual({
      version: '0.6.0',
      endpoints: undefined,
      problems: [
        { severity: 'error', code: 'RZ0318', message: 'Endpoint "GET /posts" does not say who may call it.', fix: 'Add `requires login` for logged-in users only, or `public` if anyone may call it.', line: 14, column: 5, length: 3 },
      ],
    });
  });

  it('reads audit findings with their levels and missing locations', () => {
    const r = parseAuditOutput(`some log line\n${FINDINGS}\n`) as any;
    expect(r.problems.map((p: any) => [p.severity, p.code, p.line])).toEqual([
      ['warning', 'RA01', 3],
      ['note', 'RA07', null],
    ]);
    expect(r.endpoints).toBe(4);
  });

  it('rejects output that is not a compiler result', () => {
    expect(parseAuditOutput('')).toHaveProperty('error');
    expect(parseAuditOutput('{not json')).toHaveProperty('error');
    expect(parseAuditOutput('{"hello":1}')).toHaveProperty('error');
    // Codes that don't look like Rizo Lang's are dropped, not shown.
    expect((parseAuditOutput('{"errors":[{"code":"<script>","message":"x"}]}') as any).problems).toEqual([]);
  });
});

describe('formatForModel', () => {
  it('lists each problem with its location and fix', () => {
    const text = formatForModel('app.rz', parseAuditOutput(ERRORS) as any);
    expect(text).toContain('app.rz does not build: 1 error(s) (rizolang 0.6.0)');
    expect(text).toContain('app.rz:14:5 error RZ0318: Endpoint "GET /posts" does not say who may call it.\n  fix: Add `requires login`');
  });

  it('says when the file is clean', () => {
    expect(formatForModel('app.rz', { version: '0.6.0', problems: [], endpoints: 2 })).toBe(
      'app.rz builds and the audit found nothing (rizolang 0.6.0). 2 endpoint(s).',
    );
  });
});
