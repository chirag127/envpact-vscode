# Changelog

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
