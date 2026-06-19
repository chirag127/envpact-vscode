/**
 * envpact-vscode — Sync panel HTML renderer.
 *
 * Pure module: no `vscode` import, no I/O. Lives in its own file so
 * unit tests can exercise the canary (no fixture value ever bleeds
 * into the rendered HTML) without spinning up the extension host.
 *
 * The HTML is shipped to the webview once on creation; runtime data
 * (per-key statuses, masked previews) is delivered separately via
 * `panel.webview.postMessage({type:'state', state})`. That means the
 * static template you see here NEVER contains a secret value — the
 * webview script handles all state interpolation client-side, with
 * inputs that have already been masked host-side.
 *
 * CSP:
 *   default-src 'none'
 *   script-src 'nonce-<n>'
 *   style-src  ${cspSource} 'unsafe-inline'
 *   img-src    ${cspSource} data:
 */
export function renderPanelHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
<title>envpact: Sync</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  h1 { font-size: 1.2em; margin: 0 0 8px 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; font-size: 12px; }
  th { font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-synced { background: #6c757d; color: #fff; }
  .badge-local_newer { background: #1f6feb; color: #fff; }
  .badge-vault_newer { background: #d97706; color: #fff; }
  .badge-both_diverged { background: #dc2626; color: #fff; }
  .badge-local_only { background: #7c3aed; color: #fff; }
  .badge-vault_only { background: #7c3aed; color: #fff; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; cursor: pointer; margin-right: 4px; border-radius: 3px; font-size: 11px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .toolbar { margin: 8px 0; }
  .preview { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
  .empty { padding: 16px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1 id="title">envpact Sync Panel</h1>
<div class="toolbar">
  <button id="refresh">Refresh</button>
  <button id="pullAll">Pull all available</button>
  <button id="pushAll">Push all available</button>
</div>
<div id="content"><p class="empty">Loading…</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  function send(msg) { vscode.postMessage(msg); }
  document.getElementById('refresh').addEventListener('click', () => send({ type: 'refresh' }));
  document.getElementById('pullAll').addEventListener('click', () => send({ type: 'pullAllAvailable' }));
  document.getElementById('pushAll').addEventListener('click', () => send({ type: 'pushAllAvailable' }));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(state) {
    document.getElementById('title').textContent =
      state.project ? ('envpact Sync — ' + state.project) : 'envpact Sync Panel';
    const root = document.getElementById('content');
    if (!state.workspaceOpen) {
      root.innerHTML = '<p class="empty">Open a workspace folder to inspect sync status.</p>';
      return;
    }
    if (!state.vaultExists) {
      root.innerHTML = '<p class="empty">Vault not initialised. Run "envpact: Initialize Vault".</p>';
      return;
    }
    if (!state.rows || state.rows.length === 0) {
      root.innerHTML = '<p class="empty">No keys to display for this project.</p>';
      return;
    }
    let html = '<table><thead><tr><th>Key</th><th>Status</th><th>Local mtime / Vault mtime</th><th>Preview</th><th>Actions</th></tr></thead><tbody>';
    for (const r of state.rows) {
      const vm = r.vault_modified_at ? new Date(r.vault_modified_at).toLocaleString() : '—';
      const lm = r.lock_modified_at ? new Date(r.lock_modified_at).toLocaleString() : '—';
      const status = r.status;
      html += '<tr>'
        + '<td>' + escapeHtml(r.key) + '</td>'
        + '<td><span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></td>'
        + '<td>local: ' + escapeHtml(lm) + ' / vault: ' + escapeHtml(vm) + '</td>'
        + '<td class="preview">' + escapeHtml(r.masked_preview || '') + '</td>'
        + '<td>'
        + '<button data-act="pull" data-key="' + escapeHtml(r.key) + '">Pull</button>'
        + '<button data-act="push" data-key="' + escapeHtml(r.key) + '">Push</button>'
        + '<button data-act="forcePull" data-key="' + escapeHtml(r.key) + '">Force pull</button>'
        + '<button data-act="forcePush" data-key="' + escapeHtml(r.key) + '">Force push</button>'
        + '</td></tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
    for (const btn of root.querySelectorAll('button[data-act]')) {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
        const key = btn.getAttribute('data-key');
        if (act === 'pull') send({ type: 'pullKey', key, projectOrShared: 'project', force: false });
        if (act === 'push') send({ type: 'pushKey', key, projectOrShared: 'project', force: false });
        if (act === 'forcePull') send({ type: 'pullKey', key, projectOrShared: 'project', force: true });
        if (act === 'forcePush') send({ type: 'pushKey', key, projectOrShared: 'project', force: true });
      });
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.type === 'state') render(m.state);
  });
  send({ type: 'refresh' });
</script>
</body>
</html>`;
}
