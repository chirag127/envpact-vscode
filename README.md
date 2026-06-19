# envpact (VS Code)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/chirag127.envpact)](https://marketplace.visualstudio.com/items?itemName=chirag127.envpact)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/chirag127.envpact)](https://marketplace.visualstudio.com/items?itemName=chirag127.envpact)

VS Code extension for **envpact** — manage your centralized
secrets vault visually inside the editor.

> Browse projects, sync per-token from the tree view or a dedicated
> Sync panel, rotate shared secrets, and generate `.env` files
> without leaving VS Code.

Part of the [envpact](https://github.com/chirag127/envpact)
ecosystem. v0.5.0 ships the v3 vault schema (flat, single-environment,
per-key timestamps) — environments were removed in v0.5.0 (see
[CHANGELOG.md](./CHANGELOG.md)).

## Features

- **Projects sidebar** with per-key status indicators for the active
  workspace project: ✓ synced, ↑ local_newer, ↓ vault_newer,
  ⚠ both_diverged, 🆕 local-only / vault-only.
- **Shared secrets sidebar** with masked encrypted/plain indicators.
- **Per-token sync** with two surfaces:
  - **Right-click any key** in the Projects view for `Pull`, `Push`,
    `Force pull (overwrite local)`, `Force push (overwrite vault)`.
    Each shows a masked confirmation (first 3 + last 3 chars of the
    value) before any disk write.
  - **Sync panel** (envpact: Open Sync Panel, or the sync icon in
    the Projects view title bar): a single-page table with status
    badges, timestamps, masked previews, per-row buttons, and bulk
    "Pull all available" / "Push all available" actions for keys
    whose status is `local_only` / `vault_only`.
- **`.env.example.lock`** sidecar tracks last-synced state per key
  for spec-compliant conflict detection.
- **Status bar** showing the active project + vault status. Click to
  open the Sync panel.
- **Command palette** commands for every operation:
  - `envpact: Generate .env`
  - `envpact: Initialize Vault`
  - `envpact: Refresh Vault`
  - `envpact: Add Project Secret`
  - `envpact: Add Shared Secret`
  - `envpact: Rotate Shared Secret`
  - `envpact: Sync to GitHub Actions`
  - `envpact: List Projects`
  - `envpact: Open Sync Panel`
  - `envpact: Pull this key` / `Push this key` / Force variants

## Per-token sync — what gets shown, what stays hidden

Secret values **never leave the extension host**. Specifically:

- **Tree view leaves** show `KEY = ••••` only.
- **Confirmation prompts** mask values via `maskValue`: first 3
  chars + `••••` + last 3 chars (or `••••` for values shorter than
  8 chars).
- **Sync panel webview** receives only key names, status enums,
  ISO timestamps, and the masked preview. It runs under
  `default-src 'none'; script-src 'nonce-<n>'`. No external resources
  load. The static template you see if you View Source NEVER contains
  a secret value — the webview script renders host-supplied state
  only, with all values pre-masked host-side.
- **Status bar** never displays secret values.
- **Tests** include a canary asserting that no fixture value bleeds
  into the rendered HTML.

## Installation

Search "envpact" in the Extensions sidebar, or:

```
ext install chirag127.envpact
```

## Setup

You need an envpact vault. If you don't have one yet:

1. Open Command Palette → `envpact: Initialize Vault`
2. Choose **Auto** to create a new private repo via gh CLI.

(Or run `npx envpact-cli --init auto` from your terminal.)

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `envpact.autoPullOnGenerate` | `true` | Pull the vault repo before generating `.env`. |
| `envpact.exampleFile` | `""` | Workspace-relative path of the `.env.example` to use. |
| `envpact.outputFile` | `""` | Workspace-relative path of the target `.env`. |
| `envpact.writeMode` | `merge` | `ask` / `merge` / `overwrite` / `dry-run`. |
| `envpact.autoSyncOnSave` | `true` | Refresh status indicators on `.env` save. |

## Migration from v0.4.0

v0.5.0 drops environments and changes the vault schema to v3. v1/v2
vaults auto-upgrade in memory on first read; the on-disk file is
rewritten only on mutation. Make a backup branch in your vault repo
BEFORE upgrading if you want to keep per-environment history.

## Compatibility with the rest of envpact

| | Reads vault | Writes vault | Per-key sync |
| :--- | :---: | :---: | :---: |
| envpact-cli (`npx envpact-cli`) | ✓ | ✓ | ✓ |
| envpact-mcp (AI agents via MCP) | ✓ | ✓ | ✓ |
| envpact (Python) | ✓ | ✓ | ✓ |
| envpact-vscode (this) | ✓ | ✓ | ✓ |
| envpact-action (CI/CD) | ✓ (read-only) | — | — |

## License

MIT © Chirag Singhal — see [LICENSE](./LICENSE).
