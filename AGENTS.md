# AGENTS.md — envpact-vscode

## Project Context

VS Code extension that gives the envpact ecosystem a visual UI.
Reads & writes the same `~/.envpact/secrets/` clone every other
component uses. Behaviour mirrors envpact-cli exactly.

## Architecture

- TypeScript, strict mode.
- Activation: `workspaceContains:.env.example` + on-demand commands.
- Two tree-data providers: Projects, Shared Secrets.
- All git ops via `child_process.execFile('git', …)` — no nodegit.

## Key Files

- `src/extension.ts` — activation, command handlers, status bar.
- `src/sidebar.ts` — TreeDataProvider implementations.
- `src/vault.ts` — load/save/git ops.
- `src/resolver.ts` — resolution algorithm (mirrors CLI).
- `src/envwriter.ts` — .env rendering.
- `package.json` — manifest with all command/menu/view contributions.

## Conventions

- TypeScript strict mode.
- `node_modules` is large — keep `.vscodeignore` aggressive.
- All user-facing strings use `vscode.window.showInformationMessage`,
  not `console.log`.
- Mask all secret values in tree views (use `****`).
- All vault commits include `-s` (sign-off).

## Testing

```bash
npm install --ignore-scripts
node node_modules/typescript/lib/tsc.js -p ./
node --test --import tsx tests/*.test.ts
```

## Publishing

The CI workflow at `.github/workflows/publish.yml` runs `vsce
publish` on tag push. Requires the `VSCE_PAT` secret.

## Security

- NEVER show plaintext secret values in the tree view.
- `Add Secret` / `Rotate Secret` use `password: true` input boxes.
- `.env` files are written with mode 0600.
- Status bar never displays secret values.
