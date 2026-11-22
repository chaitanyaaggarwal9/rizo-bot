// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import {
  buildCompletionMessages,
  buildEditMessages,
  cleanCompletion,
  extractEditedCode,
  headLines,
  tailLines,
} from './inlinePrompts';

describe('context slices', () => {
  it('keep whole lines', () => {
    expect(tailLines('aaaa\nbbbb\ncccc', 7)).toBe('cccc');
    expect(headLines('aaaa\nbbbb\ncccc', 7)).toBe('aaaa\n');
    expect(tailLines('short', 100)).toBe('short');
  });
});

describe('buildEditMessages', () => {
  it('marks the selection, or the cursor when nothing is selected', () => {
    const edit = buildEditMessages({ path: 'a.ts', language: 'typescript', before: 'x\n', selection: 'y\n', after: 'z', instruction: ' rename ' });
    expect(edit[0].content).toContain('<selection>');
    expect(edit[1].content).toBe('File: a.ts (typescript)\n\nx\n<selection>y\n</selection>z\n\nInstruction: rename');
    const insert = buildEditMessages({ path: 'a.ts', language: 'typescript', before: 'x\n', selection: '', after: 'z', instruction: 'add' });
    expect(insert[1].content).toContain('x\n<cursor/>z');
    expect(insert[0].content).toContain('insert');
  });
});

describe('extractEditedCode', () => {
  it('takes a fenced block and keeps the original trailing newline', () => {
    expect(extractEditedCode('Here you go:\n```ts\n  const a = 1;\n```\n', '  let a = 1;\n')).toBe('  const a = 1;\n');
  });

  it('keeps first-line indentation and drops blank edges and echoed markers', () => {
    expect(extractEditedCode('\n\n    return x;\n\n', '    return y;')).toBe('    return x;');
    expect(extractEditedCode('<selection>\nfoo()\n</selection>', 'bar()\n')).toBe('foo()\n');
  });

  it('handles insertions (no original)', () => {
    expect(extractEditedCode('function f() {}\n', '')).toBe('function f() {}');
  });
});

describe('buildCompletionMessages', () => {
  it('puts the cursor between prefix and suffix', () => {
    const m = buildCompletionMessages({ path: 'a.py', language: 'python', prefix: 'def f(', suffix: ')\n' });
    expect(m[1].content).toBe('File: a.py (python)\n\ndef f(<cursor/>)\n');
  });
});

describe('cleanCompletion', () => {
  it('strips fences and an echo of the current line', () => {
    expect(cleanCompletion('```python\nreturn a + b\n```', 'def add(a, b):\n    ret', '')).toBe('urn a + b');
    expect(cleanCompletion('const total = items.length;', 'const total = ', '')).toBe('items.length;');
  });

  it('does not repeat what is already after the cursor', () => {
    expect(cleanCompletion('a, b)', 'foo(', ')')).toBe('a, b');
    expect(cleanCompletion('x)\n  y()', 'foo(', ')')).toBe('x)\n  y()');
  });

  it('returns nothing for blank replies and caps long ones', () => {
    expect(cleanCompletion('   \n ', 'x', '')).toBe('');
    expect(cleanCompletion(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), 'a\n', '').split('\n')).toHaveLength(30);
  });

  it('removes cursor markers the model echoed', () => {
    expect(cleanCompletion('<cursor/>value', 'x = ', '')).toBe('value');
  });
});
