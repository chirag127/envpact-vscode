# AGENTS.md — envpact-vscode

## Project Context

VS Code extension that gives the envpact ecosystem a visual UI.
Reads & writes the same `~/.envpact/secrets/` clone every other
component uses. Behaviour mirrors envpact-cli exactly. Runs the v3
vault schema (flat, single-environment, per-key timestamps).

## Architecture

- TypeScript, strict mode.
- Activation: `workspaceContains:.env.example` + on-demand commands.
- Two tree-data providers: Projects, Shared Secrets.
- One webview Sync panel (`envpact.openSyncPanel`).
- All git ops via `child_process.execFile('git', …)` — no nodegit.
- Vault: private GitHub repo with `secrets.json` (v3 schema, flat,
  one environment per project, per-key timestamps for conflict
  detection).
- Resolver: `shared.KEY` references, no nested per-env objects.
- Local: `~/.envpact/secrets/` (cloned vault).
- State sidecar: `<project>/.env.example.lock` per spec §1.3.

## Key Files

- `src/extension.ts` — activation, command handlers, status bar,
  tree-view → Pull/Push command glue.
- `src/sidebar.ts` — TreeDataProvider implementations + status icons.
- `src/syncPanel.ts` — webview wiring, host-side state computation.
- `src/syncPanelHtml.ts` — pure HTML renderer (no `vscode` import,
  unit-testable).
- `src/sync.ts` — TypeScript port of envpact-cli/lib/sync.js
  (getKeyStatus, pullKey, pushKey, loadLock/saveLock, statusReport).
- `src/vault.ts` — load/save/git ops, v3 entry mutation helpers.
- `src/resolver.ts` — resolution algorithm (mirrors CLI), v1/v2 → v3
  in-memory upgrade, `maskValue`.
- `src/envwriter.ts` — .env rendering, parsing, merging (no env
  header in v3).
- `src/encryption-guard.ts` — `pickEncryptionFailure`,
  `stripEncrypted`, `formatEncryptionErrorMessage`.
- `package.json` — manifest with all command/menu/view contributions.

## Conventions

- Zero external runtime dependencies.
- Cross-platform paths (`path.join`).
- TypeScript strict mode.
- ESM-style imports, CommonJS-compiled output (extension host requires
  `.js` CommonJS modules).
- Mask all secret values in tree views, prompts, status bar, and the
  webview. The single canonical helper is `maskValue` from
  `src/resolver.ts`.
- All vault commits include `-s` (sign-off).
- Atomic writes for `.env`, `.env.example.lock`, and `secrets.json`.
- Webview CSP: `default-src 'none'; script-src 'nonce-<n>'`. No
  external resources. No `unsafe-inline` for scripts.

## Testing

```bash
pnpm install --ignore-scripts
pnpm exec tsc -p ./
pnpm test
```

Tests live under `tests/*.test.ts` and run via
`scripts/test.mjs` (cross-platform glob, auto-tsx import).

Coverage targets ≥80% for resolver, vault, sync, envwriter (as per
shared spec §10).

## Publishing

The CI workflow at `.github/workflows/publish.yml` runs `vsce
publish` on tag push. Requires the `VSCE_PAT` secret.

## Security

- NEVER show plaintext secret values anywhere — tree, prompts, status
  bar, webview, errors, logs.
- `Add Secret` / `Rotate Secret` use `password: true` input boxes.
- `.env` and `.env.example.lock` are written atomically (`.tmp` +
  rename).
- Status bar never displays secret values.
- Webview HTML is rendered from a pure module (`syncPanelHtml.ts`)
  with no host state interpolation — runtime values arrive via
  `postMessage` and are pre-masked host-side.
- A canary test in `tests/syncPanel.test.ts` asserts that no fixture
  secret VALUE appears in the rendered HTML.
