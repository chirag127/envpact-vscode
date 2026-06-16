// Tests for the envwriter helpers added in v0.3.0:
// parseEnvFile, planMerge, mergeEnvFile, discoverEnvFiles, suggestTargetFor.
//
// Pure functions only — no VS Code APIs, no extension activation. Run
// with `node --test --import tsx tests/*.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseEnvFile,
  planMerge,
  mergeEnvFile,
  discoverEnvFiles,
  suggestTargetFor,
} from '../src/envwriter';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-test-'));
}

// ── parseEnvFile ───────────────────────────────────────────────────────

test('parseEnvFile: returns empty for missing file', () => {
  assert.deepStrictEqual(parseEnvFile('/nope/.env'), {});
});

test('parseEnvFile: handles plain, quoted, and comment lines', () => {
  const dir = tmpDir();
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, [
    '# comment',
    '',
    'PLAIN=value',
    'QUOTED="hello world"',
    "SINGLE='raw\\nvalue'",
    'WITH_NL="line1\\nline2"',
    'EMPTY=',
    'NOT-A-KEY=ignored',
  ].join('\n'));
  const r = parseEnvFile(f);
  assert.strictEqual(r.PLAIN, 'value');
  assert.strictEqual(r.QUOTED, 'hello world');
  // Single-quoted values are kept raw — \n stays literal.
  assert.strictEqual(r.SINGLE, 'raw\\nvalue');
  // Double-quoted values get \n unescaped.
  assert.strictEqual(r.WITH_NL, 'line1\nline2');
  assert.strictEqual(r.EMPTY, '');
  assert.ok(!('NOT-A-KEY' in r));
});

// ── planMerge ──────────────────────────────────────────────────────────

test('planMerge: classifies keys into kept / overwritten / added / unchanged', () => {
  const existing = { A: '1', B: '2', C: '3' };
  const incoming = { B: '2', C: 'new', D: '4' };
  const p = planMerge(existing, incoming);
  assert.deepStrictEqual(p.kept, ['A']);
  assert.deepStrictEqual(p.unchanged, ['B']);
  assert.deepStrictEqual(p.overwritten, ['C']);
  assert.deepStrictEqual(p.added, ['D']);
});

// ── mergeEnvFile ───────────────────────────────────────────────────────

test('mergeEnvFile: vault values overlay; user-only keys preserved', () => {
  const existing = [
    '# my notes',
    'API_KEY=user-typed',
    '',
    'CUSTOM_LOCAL=keep-this',
  ].join('\n') + '\n';
  const incoming = { API_KEY: 'from-vault', NEW_KEY: 'added' };
  const result = mergeEnvFile(existing, incoming, ['API_KEY', 'NEW_KEY']);
  assert.match(result, /^# my notes/m);
  assert.match(result, /^API_KEY=from-vault$/m);
  assert.match(result, /^CUSTOM_LOCAL=keep-this$/m);
  assert.match(result, /^NEW_KEY=added$/m);
  // The "Added by envpact-vscode" header must precede the new key.
  const apiIdx = result.indexOf('NEW_KEY=');
  const headerIdx = result.indexOf('# Added by envpact-vscode');
  assert.ok(headerIdx >= 0 && headerIdx < apiIdx);
});

test('mergeEnvFile: comments and blank lines kept verbatim', () => {
  const existing = [
    '# header',
    '',
    'A=1',
    '# inline',
    'B=2',
  ].join('\n') + '\n';
  const merged = mergeEnvFile(existing, { A: '1', B: '99' }, ['A', 'B']);
  // Same comments, only B's value changed.
  assert.match(merged, /^# header$/m);
  assert.match(merged, /^# inline$/m);
  assert.match(merged, /^A=1$/m);
  assert.match(merged, /^B=99$/m);
});

test('mergeEnvFile: values needing quotes get quoted', () => {
  const existing = 'A=1\n';
  const merged = mergeEnvFile(existing, { A: 'has spaces' }, ['A']);
  assert.match(merged, /^A="has spaces"$/m);
});

// ── discoverEnvFiles ───────────────────────────────────────────────────

test('discoverEnvFiles: classifies examples and targets correctly', () => {
  const dir = tmpDir();
  for (const name of [
    '.env',
    '.env.local',
    '.env.production',
    '.env.example',
    '.env.development.example',
    'env.example',           // Next.js convention
    '.env.sample',
    'README.md',
    'package.json',
  ]) fs.writeFileSync(path.join(dir, name), '');
  const r = discoverEnvFiles(dir);
  assert.ok(r.examples.includes('.env.example'));
  assert.ok(r.examples.includes('.env.development.example'));
  assert.ok(r.examples.includes('env.example'));
  assert.ok(r.examples.includes('.env.sample'));
  assert.ok(r.targets.includes('.env'));
  assert.ok(r.targets.includes('.env.local'));
  assert.ok(r.targets.includes('.env.production'));
  // .env.example must NOT be classified as a target.
  assert.ok(!r.targets.includes('.env.example'));
  // Unrelated files must be excluded entirely.
  assert.ok(!r.examples.includes('README.md'));
  assert.ok(!r.targets.includes('package.json'));
  // Sort order: .env first among targets.
  assert.strictEqual(r.targets[0], '.env');
  // Sort order: .env.example first among examples.
  assert.strictEqual(r.examples[0], '.env.example');
});

test('discoverEnvFiles: missing dir returns empty arrays', () => {
  const r = discoverEnvFiles('/this/path/does/not/exist');
  assert.deepStrictEqual(r.examples, []);
  assert.deepStrictEqual(r.targets, []);
});

// ── suggestTargetFor ───────────────────────────────────────────────────

test('suggestTargetFor: maps example name to conventional target', () => {
  assert.strictEqual(suggestTargetFor('.env.example'), '.env');
  assert.strictEqual(suggestTargetFor('.env.production.example'), '.env.production');
  assert.strictEqual(suggestTargetFor('.env.development.example'), '.env.development');
  assert.strictEqual(suggestTargetFor('env.example'), '.env.local');
  assert.strictEqual(suggestTargetFor('.env.sample'), '.env');
});
