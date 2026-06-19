/**
 * envpact resolver — TypeScript port of envpact-cli/lib/resolver.js.
 * Bit-for-bit identical semantics. See SHARED_SPEC.md §1 (v3 schema).
 *
 * v3 is flat, single-environment, and timestamp-aware:
 *
 *   shared.<KEY>            = { value: string, _modified_at: ISO }
 *   projects.<NAME>.<KEY>   = { value: string, _modified_at: ISO }
 *
 * v1 (flat string values, no timestamps) and v2 (per-environment
 * objects + `_default_env`) vaults are auto-upgraded in memory by
 * `upgradeVault()` so resolution is uniform.
 */

export const SHARED_PREFIX = 'shared.';
export const ENC_PREFIX = 'enc:';

export interface VaultEntry {
  value: string;
  _modified_at: string;
}

export interface Vault {
  $schema?: string;
  version: 1 | 2 | 3;
  shared?: Record<string, VaultEntry>;
  projects?: Record<string, Record<string, VaultEntry>>;
  metadata?: Record<string, string>;
}

export interface ResolveResult {
  resolved: Record<string, string>;
  unresolved: string[];
  invalid: string[];
  encrypted: string[];
  missing: boolean;
}

// ---------------------------------------------------------------
// v1/v2 → v3 in-memory upgrade
// ---------------------------------------------------------------

/**
 * Pick a single string from a v2 per-environment object using the
 * spec §1.4 priority: default → production → first non-empty value.
 */
function pickFlatValue(envObj: Record<string, unknown>): string {
  const d = envObj.default;
  if (typeof d === 'string' && d.length > 0) return d;
  const p = envObj.production;
  if (typeof p === 'string' && p.length > 0) return p;
  for (const v of Object.values(envObj)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Lossy upgrade of a v1 or v2 vault to a v3 in-memory shape.
 * Idempotent: a v3 input is returned with defensive `_modified_at`
 * fills, but otherwise unchanged. Pure function — does not mutate.
 *
 * Logs a single loud warning on actual upgrade so users notice the
 * irreversible flattening of per-environment values.
 */
export function upgradeVault(vault: any): Vault {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  const incomingVersion = vault.version;
  if (incomingVersion === 3) return normaliseV3(vault);
  if (incomingVersion !== 1 && incomingVersion !== 2) {
    throw new Error(
      `Unsupported vault version: ${incomingVersion}. Expected 1, 2, or 3.`
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    `envpact: upgrading vault from v${incomingVersion} → v3. ` +
      'Per-environment values will be flattened. Backup at ' +
      "pre-v3-migration branch (if you didn't make one, abort now)."
  );

  const now = new Date().toISOString();
  const baseTs = (vault.metadata && vault.metadata.updated_at) || now;
  const out: Vault = {
    $schema: 'https://envpact.oriz.in/schema/v3.json',
    version: 3,
    shared: {},
    projects: {},
    metadata: {
      ...(vault.metadata || {}),
      updated_at: now,
    },
  };

  for (const [k, raw] of Object.entries(vault.shared || {})) {
    if (typeof raw === 'string') {
      out.shared![k] = { value: raw, _modified_at: baseTs };
    } else if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as any).value === 'string'
    ) {
      out.shared![k] = {
        value: (raw as any).value,
        _modified_at: (raw as any)._modified_at || baseTs,
      };
    }
  }

  for (const [pname, project] of Object.entries(vault.projects || {})) {
    if (!project || typeof project !== 'object') continue;
    out.projects![pname] = {};
    for (const [key, raw] of Object.entries(project as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      if (typeof raw === 'string') {
        out.projects![pname][key] = { value: raw, _modified_at: baseTs };
      } else if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as any).value === 'string' &&
        !Array.isArray(raw)
      ) {
        out.projects![pname][key] = {
          value: (raw as any).value,
          _modified_at: (raw as any)._modified_at || baseTs,
        };
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // v2 per-env object → flatten.
        const picked = pickFlatValue(raw as Record<string, unknown>);
        if (picked) {
          out.projects![pname][key] = { value: picked, _modified_at: baseTs };
        }
      }
    }
  }

  return out;
}

/**
 * Normalise a v3 vault: ensure every leaf has a `value` string and
 * `_modified_at`. Defensive no-op for clean files.
 */
function normaliseV3(vault: any): Vault {
  const out: Vault = {
    ...vault,
    shared: { ...(vault.shared || {}) },
    projects: {},
  };
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(vault.shared || {})) {
    if (v && typeof v === 'object' && typeof (v as any).value === 'string') {
      out.shared![k] = {
        value: (v as any).value,
        _modified_at: (v as any)._modified_at || now,
      };
    } else {
      out.shared![k] = v as any;
    }
  }
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    out.projects![pname] = {};
    for (const [key, raw] of Object.entries((proj as object) || {})) {
      if (key.startsWith('_')) continue;
      if (raw && typeof raw === 'object' && typeof (raw as any).value === 'string') {
        out.projects![pname][key] = {
          value: (raw as any).value,
          _modified_at: (raw as any)._modified_at || now,
        };
      } else {
        out.projects![pname][key] = raw as any;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

export function validateVault(vault: any): asserts vault is Vault {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (vault.version !== 1 && vault.version !== 2 && vault.version !== 3) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 1, 2, or 3.`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') {
    throw new Error('vault.shared must be an object');
  }
  if (vault.projects && typeof vault.projects !== 'object') {
    throw new Error('vault.projects must be an object');
  }
}

// ---------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------

/**
 * Read the current value out of a v3 entry. Returns `undefined` if
 * the entry is malformed.
 */
export function entryValue(entry: unknown): string | undefined {
  if (entry && typeof entry === 'object' && typeof (entry as any).value === 'string') {
    return (entry as any).value;
  }
  return undefined;
}

/**
 * Read the _modified_at field of a v3 entry. Returns undefined when
 * missing or malformed.
 */
export function entryModifiedAt(entry: unknown): string | undefined {
  if (
    entry &&
    typeof entry === 'object' &&
    typeof (entry as any)._modified_at === 'string'
  ) {
    return (entry as any)._modified_at;
  }
  return undefined;
}

export function resolveString(
  raw: unknown,
  shared: Record<string, VaultEntry | string> | undefined
): { value: string | null; status: 'ok' | 'unresolved' | 'invalid' | 'encrypted' } {
  if (typeof raw !== 'string') return { value: null, status: 'invalid' };
  if (raw.startsWith(ENC_PREFIX)) return { value: raw, status: 'encrypted' };
  if (raw.startsWith(SHARED_PREFIX)) {
    const k = raw.slice(SHARED_PREFIX.length);
    if (!shared || !(k in shared)) return { value: null, status: 'unresolved' };
    const sharedEntry = shared[k];
    let sharedVal: string | undefined;
    if (typeof sharedEntry === 'string') {
      sharedVal = sharedEntry;
    } else {
      sharedVal = entryValue(sharedEntry);
    }
    if (typeof sharedVal !== 'string') return { value: null, status: 'invalid' };
    if (sharedVal.startsWith(SHARED_PREFIX)) {
      // No recursion: spec §1.2 step 2.iv.
      return { value: null, status: 'invalid' };
    }
    if (sharedVal.startsWith(ENC_PREFIX)) return { value: sharedVal, status: 'encrypted' };
    return { value: sharedVal, status: 'ok' };
  }
  return { value: raw, status: 'ok' };
}

/**
 * Resolve every key in a project. See SHARED_SPEC §1.2.
 *
 * Note: NO `environment` parameter. v3 vaults are flat.
 */
export function resolveProject(vault: Vault, projectName: string): ResolveResult {
  validateVault(vault);
  const upgraded = upgradeVault(vault);
  const project = (upgraded.projects || {})[projectName];
  if (!project) {
    return {
      resolved: {},
      unresolved: [],
      invalid: [],
      encrypted: [],
      missing: true,
    };
  }

  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  const invalid: string[] = [];
  const encrypted: string[] = [];
  const shared = upgraded.shared || {};

  for (const [key, entry] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    const raw = entryValue(entry);
    if (raw === undefined) {
      invalid.push(key);
      continue;
    }
    const r = resolveString(raw, shared);
    if (r.status === 'ok' && r.value !== null) resolved[key] = r.value;
    else if (r.status === 'encrypted' && r.value !== null) {
      resolved[key] = r.value;
      encrypted.push(key);
    } else if (r.status === 'unresolved') unresolved.push(key);
    else invalid.push(key);
  }

  return { resolved, unresolved, invalid, encrypted, missing: false };
}

/**
 * Mask a secret value for display. Reveals first/last 3 chars when
 * length ≥ 8, else collapses to "••••". This is the canonical helper
 * for everything user-facing in the extension.
 */
export function maskValue(v: string): string {
  if (typeof v !== 'string') return '••••';
  if (v.length < 8) return '••••';
  return `${v.slice(0, 3)}••••${v.slice(-3)}`;
}
