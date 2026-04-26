// Manifest loader. The CLI ships a base manifest (the framework v1.0
// assertion suite) and merges in any per-product rules files found at
// <repo>/audits/rules/*.json. Per-product rules can override a base rule by
// re-using its id, or extend with new ids.

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

  const seen = new Map();
  const order = [];

  function take(rule, source) {
    if (seen.has(rule.id)) {
      seen.set(rule.id, { rule, source });
      return;
    }
    seen.set(rule.id, { rule, source });
    order.push(rule.id);
  }

  if (includeBase) {
    for (const rule of base.rules) take(rule, BASE_MANIFEST_PATH);
  }
  for (const file of repoFiles) {
    for (const rule of file.rules) take(rule, file.source);
  }

  const effective = order.map((id) => seen.get(id).rule);
  const sources = order.map((id) => seen.get(id).source);

  return {
    base,
    effective,
    sources,
    repoFiles: repoFiles.map((f) => f.source),
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
