// Manifest loader. The CLI ships a base manifest (the framework v1.0
// assertion suite) and merges in any per-product rules files found at
// <repo>/audits/rules/*.json. Per-product rules extend the base with new
// product-specific ids (HIGH-FL-*, CRIT-CL-*, etc.). Re-using a base rule id
// is forbidden (CRIT-SV-NO-BASE-ID-OVERRIDE, base v1.2.0+) and is reported
// as a collision at merge time; the colliding per-product rule is dropped
// and the base rule continues to run unchanged.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_MANIFEST_PATH = resolve(__dirname, '..', 'manifests', 'base-v1.json');

export async function loadBaseManifest() {
  const text = await readFile(BASE_MANIFEST_PATH, 'utf8');
  return JSON.parse(text);
}

export async function loadRepoManifest(repoRoot) {
  const dir = join(repoRoot, 'audits', 'rules');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('_')) continue;
    const path = join(dir, name);
    const text = await readFile(path, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`failed to parse ${path}: ${err.message}`);
    }
    if (!parsed.rules || !Array.isArray(parsed.rules)) continue;
    out.push({ source: path, rules: parsed.rules });
  }
  return out;
}

export async function buildEffectiveRules({ repoRoot, includeBase = true, baseOnly = false }) {
  const base = await loadBaseManifest();
  const repoFiles = baseOnly ? [] : await loadRepoManifest(repoRoot);

  const baseIds = new Set(base.rules.map((r) => r.id));
  const seen = new Map();
  const order = [];
  const collisions = [];

  function take(rule, source) {
    if (seen.has(rule.id)) {
      // Earlier wins. We never overwrite a previously-seen rule. For base
      // rules this is moot (uniqueness within base is a manifest-author
      // responsibility). For per-product rules colliding with base ids,
      // the collision is recorded below before take() is even called.
      return;
    }
    seen.set(rule.id, { rule, source });
    order.push(rule.id);
  }

  if (includeBase) {
    for (const rule of base.rules) take(rule, BASE_MANIFEST_PATH);
  }
  for (const file of repoFiles) {
    for (const rule of file.rules) {
      if (baseIds.has(rule.id) && includeBase) {
        // CRIT-SV-NO-BASE-ID-OVERRIDE: per-product rule re-uses a base id.
        // Drop the per-product rule; the base rule keeps running.
        collisions.push({ ruleId: rule.id, source: file.source });
        continue;
      }
      take(rule, file.source);
    }
  }

  const effective = order.map((id) => seen.get(id).rule);
  const sources = order.map((id) => seen.get(id).source);

  return {
    base,
    effective,
    sources,
    repoFiles: repoFiles.map((f) => f.source),
    collisions,
  };
}

export async function verifyBaseCoverage(repoRoot) {
  const base = await loadBaseManifest();
  const repoFiles = await loadRepoManifest(repoRoot);
  const repoIds = new Set();
  for (const file of repoFiles) {
    for (const rule of file.rules) repoIds.add(rule.id);
  }
  const missing = [];
  const present = [];
  for (const rule of base.rules) {
    if (rule.required === false) continue;
    if (repoIds.has(rule.id)) present.push(rule.id);
    else missing.push(rule.id);
  }
  return { baseVersion: base.version, missing, present };
}
