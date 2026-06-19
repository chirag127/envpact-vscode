# envpact-vscode — documentation

> VS Code extension for envpact: silent setup on first open, sidebar
> for browsing your vault, codelens on `.env.example`, auto-sync on
> `.env` save. Works alongside `envpact-cli` and the MCP server —
> they all read the same vault.

## Install

[Marketplace](https://marketplace.visualstudio.com/items?itemName=chirag127.envpact)
or [Open VSX](https://open-vsx.org/extension/chirag127/envpact). Or
search "envpact" in the VS Code Extensions view.

## What you see

- **Sidebar**: a tree of every project in your vault, plus a Shared
  panel listing every shared key.
- **Status bar**: shows the current project (auto-detected from git
  remote) and a quick action to generate `.env`.
- **Codelens on `.env.example`**: per-key resolution status —
  green if the vault has the key, yellow if it'd be promoted to
  shared, red if it's encrypted and we can't decrypt it.

## Commands

| Command (Ctrl+Shift+P) | What |
| :--- | :--- |
| `envpact: Generate .env` | Resolve cwd's `.env.example` and write `.env` (merge mode by default — preserves user-only keys) |
| `envpact: Initialize Vault` | First-time setup; clones your `<user>/envpact-secrets` to `~/.envpact/secrets` |
| `envpact: Refresh Vault` | `git pull` your vault repo |
| `envpact: Add Project Secret` | Prompt + write to vault |
| `envpact: Add Shared Secret` | Prompt + write to vault.shared |
| `envpact: Rotate Shared Secret` | Update a shared key's value across every referencing project |
| `envpact: Sync to GitHub Actions` | Run the GitHub-Actions secrets sync flow (per-key) |
| `envpact: List Projects` | Print every project the vault knows about |

## Auto-sync on save (v0.4.0+)

When you save `.env`, the extension pushes any changes back to the
vault. Conflict policy:

- **Local wins on collision** — your edit overrides the vault value
- **Remote-only keys preserved** — keys the vault has but your file
  doesn't are kept (never deleted)
- **Local-only keys promoted to SHARED** — a key you typed that the
  vault doesn't know about gets promoted to the shared namespace, so
  it's available across all your projects on every machine

Disable with `"envpact.autoSyncOnSave": false` in `.vscode/settings.json`.

## Settings

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `envpact.autoSyncOnSave` | `true` | Auto-push `.env` changes to vault |
| `envpact.writeMode` | `merge` | Behaviour when generating `.env` over an existing file. Other values: `ask`, `overwrite`, `dry-run` |
| `envpact.exampleFile` | (auto) | Pin an explicit example file path; skip detection |
| `envpact.outputFile` | (auto) | Pin an explicit target path |
| `envpact.defaultEnvironment` | `default` | Which env slot to resolve |
| `envpact.autoPullOnGenerate` | `true` | `git pull` vault before generate |

## First-run discovery

On first activation in a workspace, the extension silently runs
`gh api user --jq .login` for the username and
`git remote get-url origin` for the repo, derives a project name
`<username>/<repo>`, and caches it to `.vscode/envpact.json`.
Subsequent activations use the cached values; nothing prompts.

If `gh` isn't installed or the workspace isn't a github.com remote,
the extension falls back to an input box (asked once, cached forever).

## Auth model

Same as the rest of envpact: the extension reads `gh auth token` from
your existing GitHub CLI authentication. Storing a separate token
isn't supported — that would just be another attack surface.

## See also

- [Umbrella docs](https://chirag127.github.io/envpact/) — project overview, security model
- [envpact-cli](https://github.com/chirag127/envpact-cli) — same vault, terminal interface
