# Changelog

## [0.3.0] - 2026-06-16

### Changed (BREAKING but corrective)

- **Generate `.env` no longer overwrites your file by default.**
  v0.2.0 atomically replaced the entire `.env` with vault contents,
  silently discarding any keys you'd typed that the vault didn't know
  about. v0.3.0 defaults to a comment-preserving merge: vault values
  overlay matching keys, user-only keys are kept verbatim, comments
  and blank lines are preserved. Set `envpact.writeMode` if you want
  the old behaviour back.

### Added

- **Multi-file source/target prompts.** The Generate command now
  scans the workspace for `.env*`, `.env.*.example`, `env.example`,
  `.env.sample`, etc., and asks you to pick the spec file and the
  target file. Conventional pairings are pre-selected
  (`.env.production.example` → `.env.production`,
  `env.example` → `.env.local`, `.env.example` → `.env`).
- **Write mode prompt.** Each run asks: Merge (default) / Overwrite
  (with confirmation listing keys that would be lost) / Dry-run (show
  the plan, write nothing). Pin a default in
  `envpact.writeMode` (`ask` | `merge` | `overwrite` | `dry-run`).
- **Settings:**
  - `envpact.exampleFile` — pin a workspace-relative spec path; skip
    the prompt.
  - `envpact.outputFile` — pin a workspace-relative target path; skip
    the prompt.
  - `envpact.writeMode` — `ask` (default) | `merge` | `overwrite` |
    `dry-run`.
- **`parseEnvFile`, `planMerge`, `mergeEnvFile`, `discoverEnvFiles`,
  `suggestTargetFor`** exported from `src/envwriter.ts`. Pure
  functions, fully unit-tested (9 new tests in
  `tests/envwriter.test.ts`).

### Migration

- If you depended on the v0.2.0 always-overwrite behaviour (e.g.
  scripts that delete `.env` and re-generate to wipe stale keys),
  set `"envpact.writeMode": "overwrite"` in your settings — but
  consider whether that's actually what you want; the new
  confirmation will list every key that would be lost.

## [0.2.0] - 2026-06-16

### Changed (BREAKING but correct)

- **AUDIT #6** — The Generate `.env` command now refuses to write
  ciphertext to disk. When the resolver flags any keys as encrypted
  (`enc:*`), the extension shows an error toast naming the keys with
  two action buttons (`Run envpact-cli`, `Show in Vault`), updates
  the status bar to a red `$(error) envpact: N enc: secret(s) —
  cannot decrypt` indicator, and decorates each affected leaf in the
  Projects tree with an error icon and a remediation tooltip. The
  encrypted-detection covers both flat string values and per-environment
  objects where any override starts with `enc:`. No `.env` is written
  when encrypted keys are present.

### Added

- `src/encryption-guard.ts` — pure helpers `pickEncryptionFailure`,
  `stripEncrypted`, and `formatEncryptionErrorMessage`. Fully
  unit-tested.
- `ResolveErrorState` interface (exported from `src/sidebar.ts`) +
  `setResolveError(err)` setter on `ProjectsTreeProvider`.
- `onDidChangeWorkspaceFolders` listener that clears the
  `lastResolveError` state to avoid stale tree-view decorations.
- 5 new tests in `tests/resolver.test.ts`: resolver-still-flags-enc,
  `pickEncryptionFailure` null + non-null + sort-stability,
  `stripEncrypted` purity + cleanliness, and
  `formatEncryptionErrorMessage` content.

## [0.1.0] - 2026-06-15

### Added

- Initial release of `envpact` VS Code extension.
- Sidebar with Projects and Shared Secrets tree views.
- Status bar showing active project + vault status.
- Command palette commands for every envpact operation:
  Generate, Initialize, Refresh, Add Secret, Add Shared,
  Rotate, Sync GitHub, List Projects.
- Settings: `defaultEnvironment`, `autoPullOnGenerate`.
- Bit-for-bit identical resolver semantics with envpact-cli.
- TypeScript-first, strict mode.

[0.1.0]: https://github.com/chirag127/envpact-vscode/releases/tag/v0.1.0
