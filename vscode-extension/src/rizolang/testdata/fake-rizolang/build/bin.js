#!/usr/bin/env node
// Stands in for `rizolang audit <file> --json` in Rizo's tests. Prints the
// same JSON shapes as the real compiler.
const fs = require('fs');
const [cmd, file, flag] = process.argv.slice(2);
if (cmd !== 'audit' || flag !== '--json') {
  process.stderr.write('only audit --json is expected\n');
  process.exit(2);
}
const src = fs.readFileSync(file, 'utf8');
if (src.includes('SLOW')) {
  setTimeout(() => {}, 60000);
  return;
}
const out = { rizolang: '0.6.0' };
if (src.includes('api GET /posts {\n  return')) {
  out.ok = false;
  out.errors = [{ code: 'RZ0318', message: 'Endpoint "GET /posts" does not say who may call it.', fix: 'Add `requires login` for logged-in users only, or `public` if anyone may call it.', file, line: 3, column: 3, length: 6 }];
} else {
  out.ok = !src.includes('api POST');
  out.file = file;
  out.findings = src.includes('api POST')
    ? [{ level: 'warning', code: 'RA01', message: 'Endpoint "POST /posts" is public, so anyone can create Post records.', fix: 'Add `requires login`.', file, line: 2, column: 5, length: 4 }]
    : [];
  out.summary = { endpoints: 1, public: 1, login: 0, withRoles: 0, warnings: out.findings.length, notes: 0 };
}
// Problems the tests look for: a credential reached the compiler, or it
// ran somewhere other than a folder holding just the file.
const list = out.errors || out.findings;
if (process.env.FAKE_SECRET_TOKEN) list.push({ level: 'warning', code: 'RZ9999', message: 'a credential variable reached the compiler', fix: '' });
if (fs.readdirSync('.').length !== 1) list.push({ level: 'warning', code: 'RZ9998', message: 'not run in a private folder', fix: '' });
process.stdout.write(JSON.stringify(out) + '\n');
process.exitCode = out.ok ? 0 : 1;
