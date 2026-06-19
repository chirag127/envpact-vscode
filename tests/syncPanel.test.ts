// Sync panel webview tests — canary that no fixture VALUE bleeds into
// the rendered HTML, plus structural assertions on the rendered shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPanelHtml } from '../src/syncPanelHtml';
import { maskValue } from '../src/resolver';

const SECRET_FIXTURES = [
  'sk_live_abcdef1234567890',
  'super-secret-token',
  'PASSWORD=hunter2',
  'sk-very-long-secret-key-do-not-leak',
];

test('renderPanelHtml: never contains any fixture secret value (canary)', () => {
  const html = renderPanelHtml('test-nonce', 'vscode-resource:');
  for (const secret of SECRET_FIXTURES) {
    assert.ok(
      !html.includes(secret),
      `panel HTML must NEVER include fixture value "${secret}"`,
    );
  }
});

test('renderPanelHtml: CSP locks scripts to nonce and bans default-src', () => {
  const html = renderPanelHtml('test-nonce', 'vscode-resource:');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-test-nonce'/);
  // No inline script attributes (only the one with nonce).
  assert.doesNotMatch(html, /<script(?![^>]*\bnonce=)/);
});

test('renderPanelHtml: contains all 6 status badge classes', () => {
  const html = renderPanelHtml('n', 'vscode-resource:');
  for (const status of ['synced', 'local_newer', 'vault_newer', 'both_diverged', 'local_only', 'vault_only']) {
    assert.match(
      html,
      new RegExp(`badge-${status}`),
      `panel HTML must declare CSS for badge-${status}`,
    );
  }
});

test('renderPanelHtml: includes Refresh, Pull all, Push all toolbar buttons', () => {
  const html = renderPanelHtml('n', 'vscode-resource:');
  assert.match(html, /id="refresh"/);
  assert.match(html, /id="pullAll"/);
  assert.match(html, /id="pushAll"/);
});

test('renderPanelHtml: ships a client-side IST formatter (Asia/Kolkata)', () => {
  const html = renderPanelHtml('n', 'vscode-resource:');
  assert.match(html, /Asia\/Kolkata/);
  // The toIst helper is what converts UTC ISO → IST display string.
  assert.match(html, /function toIst/);
});

test('renderPanelHtml: declares the (newer side: …) hint helper', () => {
  const html = renderPanelHtml('n', 'vscode-resource:');
  assert.match(html, /newer side: vault/);
  assert.match(html, /newer side: local/);
});

test('renderPanelHtml: column header advertises hover-for-UTC', () => {
  const html = renderPanelHtml('n', 'vscode-resource:');
  assert.match(html, /Last modified \(IST — hover for UTC\)/);
});

// ── maskValue is the only path values can take into the UI ─────────────

test('maskValue: never reveals more than 6 chars total of long values', () => {
  for (const v of SECRET_FIXTURES) {
    const m = maskValue(v);
    // Count alphanumeric+symbol chars from the original that remain.
    // Reveal contract: first 3 + last 3 only.
    const revealed = m.replace(/•/g, '');
    assert.ok(
      revealed.length <= 6,
      `mask must reveal ≤6 chars of "${v}", got "${m}" (${revealed.length} revealed)`,
    );
    // The full middle of the secret must NOT survive the mask.
    if (v.length > 6) {
      const middle = v.slice(3, -3);
      assert.ok(!m.includes(middle), `middle "${middle}" leaked into mask "${m}"`);
    }
  }
});
