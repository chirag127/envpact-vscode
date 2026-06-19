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
ecosystem. v0.6.0 ships v3.1 UX additions on top of the v3 vault
schema (flat, single-environment, per-key timestamps): every
conflict prompt renders timestamps in BOTH UTC and IST, the Sync
panel shows IST with UTC in the tooltip, and a new
`envpact: Sync Global .env` command mirrors every shared secret to
`~/.envpact/.env`. See [CHANGELOG.md](./CHANGELOG.md).

## Features

- **Projects sidebar** with per-key status indicators for the active
  workspace project: ✓ synced, ↑ local_newer, ↓ vault_newer,
  ⚠ both_diverged, 🆕 local-only / vault-only.
- **Shared secrets sidebar** with masked encrypted/plain indicators.
- **Per-token sync** with two surfaces:
  - **Right-click any key** in the Projects view for `Pull`, `Push`,
    `Force pull (overwrite local)`, `Force push (overwrite vault)`.
    Each shows a masked confirmation (first 3 + last 3 chars of the
    value) before any disk write. When the underlying status is a
    conflict, the modal also shows a SHARED_SPEC §1.5 conflict block
    with vault and local timestamps in BOTH UTC and IST; the newer
    side gets a `(Recommended — newer)` annotation.
  - **Sync panel** (envpact: Open Sync Panel, or the sync icon in
    the Projects view title bar): a single-page table with status
    badges, dual-rendered timestamps (IST shown, UTC in the
    `title=` tooltip), masked previews, per-row buttons, and bulk
    "Pull all available" / "Push all available" actions for keys
    whose status is `local_only` / `vault_only`. Conflict badges
    grow a small `(newer side: vault)` / `(newer side: local)` hint
    so you can see at a glance which side to accept.
- **Global vault `.env`** at `~/.envpact/.env` mirrors every shared
  secret. Regenerate via `envpact: Sync Global .env` (palette only).
  The template `~/.envpact/.env.example.global` is auto-created on
  first sync — edit it to control the order, comments, and which
  shared keys are mirrored.
- **`.env.example.lock`** sidecar tracks last-synced state per key
  for spec-compliant conflict detection.
- **Status bar** showing the active project + vault status. Click to
  open the Sync panel.
- **Byte-faithful `.env` generation**: the rendered file mirrors
  `.env.example` line-by-line — comments (with leading whitespace),
  blank lines, key order, CRLF, and trailing-newline-or-not are all
  preserved verbatim. Missing keys become `# KEY: unresolved`
  comment lines so you notice.
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
  - `envpact: Sync Global .env`
  - `envpact: Pull this key` / `Push this key` / Force variants

## Timestamp dual-render (UTC + IST)

Every prompt that asks you to choose between two timestamps shows
both renderings — there are no screenshots to memorise; the format
is always:

```
Conflict on KEY = OPENAI_API_KEY (project: my-app, status: vault_newer)

  Vault:  2026-06-19T07:30:00.000Z
          → 2026-06-19 13:00:00 IST   (Recommended — newer)
  Local:  2026-06-19T07:25:00.000Z
          → 2026-06-19 12:55:00 IST
```

IST is fixed to `Asia/Kolkata` regardless of your machine's local
timezone. The Sync panel's Last-modified column shows the IST
rendering inline with the UTC string in a `title=` hover tooltip,
so two clicks of the same row never produce different formats.

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

## Migration from v0.5.0

v0.6.0 is a drop-in replacement. v3.1 is purely additive UX — the
vault format on disk is unchanged. Until you run the new
`envpact: Sync Global .env` command, nothing in `~/.envpact/` is
touched.

## Migration from v0.4.0

v0.5.0 dropped environments and changed the vault schema to v3. v1/v2
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
