// Tests for envwriter helpers — v3 has no environment header.

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseEnvFile,
  parseEnvFileToMap,
  planMerge,
  mergeEnvFile,
  renderEnv,
  upsertEnvKey,
  discoverEnvFiles,
  suggestTargetFor,
} from '../src/envwriter';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-test-'));
}

// ── parseEnvFile / parseEnvFileToMap ───────────────────────────────────

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
  assert.strictEqual(r.SINGLE, 'raw\\nvalue');
  assert.strictEqual(r.WITH_NL, 'line1\nline2');
  assert.strictEqual(r.EMPTY, '');
  assert.ok(!('NOT-A-KEY' in r));
});

test('parseEnvFileToMap is alias for parseEnvFile', () => {
  const dir = tmpDir();
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'A=1\nB=2\n');
  assert.deepStrictEqual(parseEnvFileToMap(f), { A: '1', B: '2' });
});

// ── planMerge ──────────────────────────────────────────────────────────

test('planMerge: classifies keys', () => {
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
});

// ── renderEnv ──────────────────────────────────────────────────────────

test('renderEnv: NO environment header in v3', () => {
  const out = renderEnv(['A', 'B'], { A: '1', B: '2' }, { project: 'me/app' });
  assert.match(out, /A=1/);
  assert.match(out, /B=2/);
  assert.match(out, /^# project: me\/app$/m);
  // Crucially: no environment header.
  assert.doesNotMatch(out, /environment:/);
  assert.doesNotMatch(out, /env:/);
});

// ── upsertEnvKey ───────────────────────────────────────────────────────

test('upsertEnvKey: replaces existing key, preserves comments', () => {
  const dir = tmpDir();
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, '# header\nA=old\nB=2\n');
  upsertEnvKey(f, 'A', 'new');
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /^# header$/m);
  assert.match(txt, /^A=new$/m);
  assert.match(txt, /^B=2$/m);
});

test('upsertEnvKey: inserts new key when missing', () => {
  const dir = tmpDir();
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'A=1\n');
  upsertEnvKey(f, 'B', '2');
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /^A=1$/m);
  assert.match(txt, /^B=2$/m);
});

// ── discoverEnvFiles / suggestTargetFor ────────────────────────────────

test('discoverEnvFiles: classifies examples and targets correctly', () => {
  const dir = tmpDir();
  for (const name of [
    '.env',
    '.env.local',
    '.env.example',
    '.env.development.example',
    'env.example',
    '.env.sample',
    'README.md',
  ]) fs.writeFileSync(path.join(dir, name), '');
  const r = discoverEnvFiles(dir);
  assert.ok(r.examples.includes('.env.example'));
  assert.ok(r.examples.includes('.env.development.example'));
  assert.ok(r.targets.includes('.env'));
  assert.ok(!r.targets.includes('.env.example'));
  assert.strictEqual(r.targets[0], '.env');
  assert.strictEqual(r.examples[0], '.env.example');
});

test('suggestTargetFor: maps example name to conventional target', () => {
  assert.strictEqual(suggestTargetFor('.env.example'), '.env');
  assert.strictEqual(suggestTargetFor('.env.production.example'), '.env.production');
  assert.strictEqual(suggestTargetFor('env.example'), '.env.local');
});
