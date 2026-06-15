/**
 * envpact-vscode encryption guard — pure helpers around ResolveResult.
 *
 * The VS Code extension cannot decrypt `enc:` values (no age private key
 * is wired into the extension host), so when resolveProject() returns
 * encrypted leaves we must (a) detect them, (b) strip them out of the
 * resolved map before any .env write, and (c) format a message that
 * tells the user how to recover (run envpact-cli, which CAN decrypt).
 *
 * Everything in this module is deterministic and side-effect-free so
 * the helpers can be unit-tested with plain `node --test`.
 */

import type { ResolveResult } from './resolver';

export interface EncryptionFailure {
  /** Sorted, deduplicated list of keys whose resolved value is `enc:...`. */
  keys: string[];
  /** Resolved environment that produced the encrypted leaves. */
  environment: string;
}

/**
 * Returns an EncryptionFailure when the resolve result contains any
 * encrypted leaves the extension cannot decrypt; otherwise null.
 *
 * Sort order is stable (locale-independent default sort) so callers
 * can compare failure shapes across runs.
 */
export function pickEncryptionFailure(result: ResolveResult): EncryptionFailure | null {
  if (!result || !Array.isArray(result.encrypted) || result.encrypted.length === 0) {
    return null;
  }
  const keys = Array.from(new Set(result.encrypted)).sort();
  return { keys, environment: result.environment };
}

/**
 * Returns a copy of the result with every encrypted leaf removed from
 * `resolved`. The original result is not mutated. Encrypted keys are
 * surfaced via `result.encrypted` already, so dropping them from
 * `resolved` lets the writer continue safely without leaking ciphertext
 * into a .env file.
 */
export function stripEncrypted(result: ResolveResult): ResolveResult {
  if (!result || !Array.isArray(result.encrypted) || result.encrypted.length === 0) {
    return result;
  }
  const blocked = new Set(result.encrypted);
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.resolved || {})) {
    if (blocked.has(k)) continue;
    cleaned[k] = v;
  }
  return {
    ...result,
    resolved: cleaned,
  };
}

/**
 * Builds the user-facing error string shown in the toast and tooltip
 * when encrypted leaves are encountered. Mentions the project, the
 * environment, the offending keys, and the remediation (envpact-cli
 * has the age private key; the extension does not).
 */
export function formatEncryptionErrorMessage(
  project: string,
  environment: string,
  failure: EncryptionFailure
): string {
  const envLabel = environment || failure.environment || 'default';
  const keyList = failure.keys.join(', ');
  const plural = failure.keys.length === 1 ? 'secret' : 'secrets';
  const projectLabel = project || '(unknown project)';
  return (
    `envpact: cannot decrypt ${failure.keys.length} encrypted ${plural} ` +
    `in project "${projectLabel}" (env=${envLabel}): ${keyList}. ` +
    `The VS Code extension does not hold the age private key — ` +
    `run envpact-cli locally to generate the .env, or open the ` +
    `Vault sidebar to inspect the affected entries.`
  );
}
