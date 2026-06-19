# Changelog

## [0.5.0] - 2026-06-19

### BREAKING

- **Vault schema v3.** The vault is now flat, single-environment, and
  per-key timestamp-aware. Every leaf in `secrets.json` is an entry
  object `{value: string, _modified_at: ISO8601}`. v1 (flat strings)
  and v2 (per-environment objects + `_default_env`) vaults
  auto-upgrade in memory on first read, with a loud warning. The
  upgrade flattens per-environment values to one (priority:
  `default` → `production` → first non-empty). See
  [SHARED_SPEC §1](../specs/SHARED_SPEC.md) for the full schema.
- **Environments removed.** No more environment QuickPick, no more
  `envpact.defaultEnvironment` setting, no more env-aware status
  bar text. v3 represents one environment per project; users wanting
  multi-environment isolation should use multiple project names
  (e.g. `my-app-prod` / `my-app-dev`).
- **Auto-sync-on-save no longer pushes silently.** v0.4.0 pushed the
  whole `.env` to the vault on every save, with auto-promotion of
  new local keys to the SHARED namespace. v0.5.0 replaces that with
  per-key sync controls — you decide which key goes which way.

### Added

- **Per-token sync** with two surfaces:
  - **Tree-view context menu** on every key in the Projects view:
    - `envpact: Pull this key`
    - `envpact: Push this key`
    - `envpact: Force pull (overwrite local)`
    - `envpact: Force push (overwrite vault)`
    Each prompts a masked confirmation (first 3 + last 3 chars only,
    or `••••` if the value is shorter than 8 chars) before any
    on-disk change.
  - **Sync panel** webview (`envpact: Open Sync Panel`, also pinned
    to the Projects view title bar). Single-page table with status
    badges (synced / local_newer / vault_newer / both_diverged /
    local_only / vault_only), per-row pull/push/force-pull/force-push
    buttons, and "Pull all available" / "Push all available" bulk
    actions for non-conflict statuses. Strict CSP: `default-src
    'none'; script-src 'nonce-<n>'`. Webview NEVER receives a raw
    secret value — only key names, timestamps, and masked previews.
- **Status indicators in the Projects tree** for each key in the
  active workspace's project: ✓ synced, ↑ local_newer,
  ↓ vault_newer, ⚠ both_diverged, 🆕 local_only / vault_only.
- **`.env.example.lock`** state sidecar, written next to
  `.env.example`. JSON, human-readable, conflict-detection baseline
  per key. Travels with the project's required-key spec in git.
- **`maskValue`** canonical masking helper exported from
  `src/resolver.ts`.

### Changed

- **`renderEnv`** no longer emits an `environment:` header.
- **`parseEnvFileToMap`** alias added to match the canonical CLI/MCP
  port surface.
- **`watcher.ts`** no longer auto-pushes; on `.env` save it triggers
  a tree-view + status-bar refresh so the new per-key indicators
  update.

### Migration from 0.4.0

- The first run after upgrade detects v1/v2 vaults and flattens them
  in memory. The on-disk file isn't rewritten until you mutate the
  vault (Add/Rotate, or Push a key). Make a backup branch in your
  vault repo BEFORE upgrading if you want to keep the per-environment
  history accessible.
- If you depended on the v0.4.0 push-on-save policy (auto-promote
  local-only keys to SHARED), you now drive that explicitly via the
  Sync panel's "Push all available" button or the per-key push from
  the tree-view context menu.

## [0.4.0] - 2026-06-16

### Changed (silent UX rewrite)

- **Zero-prompt setup.** First activation in a workspace silently
  detects your GitHub username (via `gh api user`) and the repo name
  (via `git remote get-url origin`) and caches them in
  `.vscode/envpact.json`.
- **Project names are now `<username>/<repo>`** (e.g.
  `chirag127/envpact`).
- **`envpact.writeMode` default is now `merge`** instead of `ask`.

### Added

- **Auto-sync on `.env` save** (replaced in v0.5.0).
- **`envpact.autoSyncOnSave`** setting.
- **`src/setup.ts`** — silent first-run discovery via `gh` CLI + git
  remote.

## [0.3.0] - 2026-06-16

### Changed (BREAKING but corrective)

- **Generate `.env` no longer overwrites your file by default.**

### Added

- **Multi-file source/target prompts.**
- **Write mode prompt.**

## [0.2.0] - 2026-06-16

### Changed (BREAKING but correct)

- The Generate `.env` command refuses to write ciphertext to disk.

### Added

- `src/encryption-guard.ts` — pure helpers `pickEncryptionFailure`,
  `stripEncrypted`, and `formatEncryptionErrorMessage`.

## [0.1.0] - 2026-06-15

### Added

- Initial release of `envpact` VS Code extension.

[0.1.0]: https://github.com/chirag127/envpact-vscode/releases/tag/v0.1.0
