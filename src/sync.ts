// Push-to-vault sync logic for v0.4.0.
//
// Conflict policy (chosen by user, locked-in):
//   1. Local .env values overwrite remote on key collision
//   2. Remote-only keys are PRESERVED (never deleted)
//   3. Local-only keys (typed by user, not in vault) are auto-promoted
//      to the SHARED namespace so they're available across all the
//      user's projects on every machine
//   4. Only the canonical .env file is used as source of truth.
//      .env.production etc. are derived (read-only from the vault).

import * as fs from 'node:fs';
import { Vault } from './resolver';
import { setProjectSecret, setSharedSecret } from './vault';
import { parseEnvFile } from './envwriter';

export interface SyncPlan {
  /** Keys present in vault project but not in local — kept (no-op) */
  remoteOnlyKept: string[];
  /** Keys present in both, vault value already matches local — no-op */
  unchanged: string[];
  /** Keys whose local value differs from vault → vault gets local value */
  overwritten: string[];
  /** Keys in local that vault doesn't know about → promoted to SHARED */
  promotedToShared: string[];
  /** Brand-new project keys → set on the project map */
  addedToProject: string[];
}

/**
 * Read a local .env, compare to the current vault state for the
 * given project, and apply the conflict policy. Mutates `vault` in
 * place; the caller is responsible for saving.
 *
 * Why mutate in place: vault.ts's saveVault writes the whole JSON
 * atomically; computing a new vault object and copying it back is
 * waste motion when we already have a reference.
 */
export function pushLocalEnvToVault(
  vault: Vault,
  project: string,
  envFilePath: string,
  environment?: string,
): SyncPlan {
  const local = parseEnvFile(envFilePath);
  const plan: SyncPlan = {
    remoteOnlyKept: [],
    unchanged: [],
    overwritten: [],
    promotedToShared: [],
    addedToProject: [],
  };

  vault.projects = vault.projects || {};
  vault.shared = vault.shared || {};
  const proj = vault.projects[project] || {};
  vault.projects[project] = proj;

  // For each key in the local .env, decide where it lands.
  for (const [key, localValue] of Object.entries(local)) {
    // Does this key already exist as a project secret?
    const existingProjectVal = proj[key];
    if (typeof existingProjectVal === 'string') {
      // String form (no per-environment split)
      if (existingProjectVal === localValue) {
        plan.unchanged.push(key);
      } else if (existingProjectVal.startsWith('shared.')) {
        // It's a shared.* reference; update the SHARED value, not the project ref.
        const sharedKey = existingProjectVal.slice('shared.'.length);
        if (vault.shared[sharedKey] !== localValue) {
          vault.shared[sharedKey] = localValue;
          plan.overwritten.push(key);
        } else {
          plan.unchanged.push(key);
        }
      } else {
        proj[key] = localValue;
        plan.overwritten.push(key);
      }
      continue;
    }
    if (existingProjectVal && typeof existingProjectVal === 'object' && !Array.isArray(existingProjectVal)) {
      // Per-environment map. We're either updating the requested env,
      // or — if no env was given — the 'default' slot.
      const envSlot = environment || 'default';
      const cur = (existingProjectVal as Record<string, string>)[envSlot];
      if (cur === localValue) {
        plan.unchanged.push(key);
      } else {
        (existingProjectVal as Record<string, string>)[envSlot] = localValue;
        plan.overwritten.push(key);
      }
      continue;
    }

    // Not in this project. Check shared.
    if (key in vault.shared) {
      if (vault.shared[key] !== localValue) {
        vault.shared[key] = localValue;
        plan.overwritten.push(key);
      } else {
        plan.unchanged.push(key);
      }
      // Wire the project to reference the shared key so other
      // projects that look it up by name see the same value.
      if (proj[key] === undefined) {
        proj[key] = `shared.${key}`;
        plan.addedToProject.push(key);
      }
      continue;
    }

    // Brand-new key. Per the user's chosen policy, promote to SHARED.
    vault.shared[key] = localValue;
    proj[key] = `shared.${key}`;
    plan.promotedToShared.push(key);
    plan.addedToProject.push(key);
  }

  // Vault keys NOT in local — preserve, no-op. Just record them so
  // the caller can show "kept N remote-only keys" in the toast.
  for (const k of Object.keys(proj)) {
    if (!(k in local)) plan.remoteOnlyKept.push(k);
  }

  return plan;
}

/** Format a plan as a one-line toast message. */
export function summarisePlan(plan: SyncPlan): string {
  const bits: string[] = [];
  if (plan.overwritten.length) bits.push(`${plan.overwritten.length} updated`);
  if (plan.promotedToShared.length) bits.push(`${plan.promotedToShared.length} promoted to shared`);
  if (plan.addedToProject.length && !plan.promotedToShared.length) bits.push(`${plan.addedToProject.length} added`);
  if (plan.remoteOnlyKept.length) bits.push(`${plan.remoteOnlyKept.length} remote-only kept`);
  if (!bits.length) return 'no changes';
  return bits.join(', ');
}
