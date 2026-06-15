# envpact (VS Code)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/chirag127.envpact)](https://marketplace.visualstudio.com/items?itemName=chirag127.envpact)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/chirag127.envpact)](https://marketplace.visualstudio.com/items?itemName=chirag127.envpact)

VS Code extension for **envpact** — manage your centralized
secrets vault visually inside the editor.

> Browse projects, rotate shared secrets, and generate `.env`
> files without leaving VS Code.

Part of the [envpact](https://github.com/chirag127/envpact)
ecosystem.

## Features

- **Sidebar** with two views:
  - Projects: every project in your vault with key counts and environments.
  - Shared Secrets: every shared key with masked indicator (encrypted/plain).
- **Status bar** showing the active project + vault status.
- **Command palette** commands for every operation:
  - `envpact: Generate .env`
  - `envpact: Initialize Vault`
  - `envpact: Refresh Vault`
  - `envpact: Add Project Secret`
  - `envpact: Add Shared Secret`
  - `envpact: Rotate Shared Secret`
  - `envpact: Sync to GitHub Actions`
  - `envpact: List Projects`
- **Quick Pick** environment selection (default/development/staging/production/custom).
- **Secret prompts** use VS Code's password input (masked while typing).

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
| `envpact.defaultEnvironment` | `default` | Environment to use when generating `.env`. |
| `envpact.autoPullOnGenerate` | `true` | Pull the vault repo before generating `.env`. |

## Security

- The extension reads `~/.envpact/secrets/secrets.json` directly.
  Nothing is ever sent to a third party.
- Secret values are NEVER displayed in the sidebar — only names + a
  masked indicator (`****`).
- `Add Secret` / `Rotate Secret` use VS Code's password input.
- All vault commits are signed-off (`-s`).

## Compatibility with the rest of envpact

| | Reads vault | Writes vault | Pull/Push |
| :--- | :---: | :---: | :---: |
| envpact-cli (`npx envpact-cli`) | ✓ | ✓ | ✓ |
| envpact-mcp (AI agents via MCP) | ✓ | ✓ | ✓ |
| envpact (Python) | ✓ | ✓ | ✓ |
| envpact-vscode (this) | ✓ | ✓ | ✓ |
| envpact-action (CI/CD) | ✓ (read-only) | — | — |

## License

MIT © Chirag Singhal — see [LICENSE](./LICENSE).
