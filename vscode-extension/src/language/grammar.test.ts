// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Checks for the Rizo Lang grammar (syntaxes/) and its registration in
// package.json. VS Code tokenizes with Oniguruma; the patterns here only use
// syntax JavaScript understands too, so every one is compiled as a RegExp.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const grammar = read('syntaxes/rizolang.tmLanguage.json');
const markdown = read('syntaxes/rizolang.markdown.tmLanguage.json');
const pkg = read('package.json');

function patterns(node: any, out: { name: string; source: string }[] = []): { name: string; source: string }[] {
  if (!node || typeof node !== 'object') return out;
  for (const key of ['match', 'begin', 'end', 'while']) {
    if (typeof node[key] === 'string') out.push({ name: node.name ?? key, source: node[key] });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') patterns(v, out);
  return out;
}

// The first pattern in the grammar that matches the word, as the scope it gives.
function scopeOf(word: string): string | undefined {
  for (const p of grammar.repository.body.patterns) {
    if (!p.match || !p.name) continue;
    const m = new RegExp(p.match).exec(word);
    if (m && m.index === 0 && m[0] === word) return p.name;
  }
  return undefined;
}

describe('Rizo Lang grammar', () => {
  it('compiles every pattern', () => {
    for (const p of patterns(grammar)) expect(() => new RegExp(p.source), p.name).not.toThrow();
    // \G is Oniguruma-only; the Markdown injection uses it as VS Code's own grammars do.
    for (const p of patterns(markdown)) expect(() => new RegExp(p.source.replace(/\\G/g, '')), p.name).not.toThrow();
  });

  it('is registered for .rz files and Markdown code blocks', () => {
    const lang = pkg.contributes.languages.find((l: any) => l.id === 'rizolang');
    expect(lang.extensions).toEqual(['.rz']);
    expect(fs.existsSync(path.join(root, lang.configuration))).toBe(true);
    const scopes = pkg.contributes.grammars.map((g: any) => g.scopeName);
    expect(scopes).toEqual(['source.rizolang', 'markdown.rizolang.codeblock']);
    for (const g of pkg.contributes.grammars) expect(fs.existsSync(path.join(root, g.path))).toBe(true);
    expect(grammar.scopeName).toBe('source.rizolang');
  });

  it('highlights every type, modifier and keyword in the 0.6 spec', () => {
    for (const t of ['Text', 'Number', 'Bool', 'Email', 'Password', 'Date', 'ID']) expect(scopeOf(t)).toBe('support.type.primitive.rizolang');
    for (const m of ['unique', 'optional', 'private', 'encrypted', 'min', 'max']) expect(scopeOf(m)).toBe('storage.modifier.rizolang');
    for (const k of ['public', 'requires', 'login', 'role', 'owner', 'or']) expect(scopeOf(k)).toBe('keyword.control.access.rizolang');
    for (const k of ['title', 'text', 'link', 'show', 'form', 'button']) expect(scopeOf(k)).toBe('keyword.other.page.rizolang');
    for (const k of ['list', 'with', 'order', 'desc', 'limit', 'per', 'keep', 'contains']) expect(scopeOf(k)).toBe('keyword.other.rizolang');
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(scopeOf(m)).toBe('support.constant.http-method.rizolang');
    expect(scopeOf('me')).toBe('variable.language.me.rizolang');
    expect(scopeOf('?q')).toBe('variable.parameter.query.rizolang');
    expect(scopeOf('/api/posts/:id')).toBe('string.unquoted.path.rizolang');
    expect(scopeOf('Post')).toBe('entity.name.type.model.rizolang');
  });

  it('recognizes the top-level declarations', () => {
    const decl = grammar.repository.declaration.patterns.map((p: any) => new RegExp(p.match));
    const lines = ['model Post {', 'auth User by email roles admin, editor', 'privacy for EU, UK', 'api PATCH /api/posts/:id -> Post.public {', 'page /posts/new {', '  title: Text min 1 max 200'];
    for (const line of lines) expect(decl.some((r: RegExp) => r.test(line)), line).toBe(true);
  });
});
