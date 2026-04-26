// File-walk, glob, and pattern helpers. Ported from the per-product audit
// runners so the standalone CLI is self-contained.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

const DEFAULT_SKIP_DIRS = [
  'node_modules',
  '.next',
  '.next-build',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.cache',
  '.claude',
  '.vercel',
  'deploy-staging',
];

export function globToRegExp(glob) {
  const normalized = glob.split(sep).join('/');
  let re = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (normalized[i] === '/') i++;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = normalized.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
        continue;
      }
      const options = normalized
        .slice(i + 1, end)
        .split(',')
        .map((o) => o.trim().replace(/[.+^$|()\\[\]\\\\]/g, (m) => `\\${m}`));
      re += `(${options.join('|')})`;
      i = end + 1;
      continue;
    }
    if ('.+^$|()[]\\'.includes(c)) {
      re += `\\${c}`;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(relPath, globs) {
  if (!globs || globs.length === 0) return false;
  const normalized = relPath.split(sep).join('/');
  return globs.some((g) => globToRegExp(g).test(normalized));
}

export async function findFiles(root, globs, skipDirs = DEFAULT_SKIP_DIRS) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.includes(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        if (globs.some((g) => globToRegExp(g).test(rel))) out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export async function readFileSafe(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

export function existsSyncSafe(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export async function readAuditIgnore(repoRoot) {
  const path = join(repoRoot, '.auditignore');
  const text = await readFileSafe(path);
  if (!text) return [];
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const commentIdx = line.indexOf('#');
    const body = commentIdx === -1 ? line : line.slice(0, commentIdx).trim();
    const reason = commentIdx === -1 ? '' : line.slice(commentIdx + 1).trim();
    const parts = body.split(/\s+/);
    if (parts.length < 2) continue;
    const [ruleId, ...rest] = parts;
    entries.push({ ruleId, pattern: rest.join(' '), reason });
  }
  return entries;
}

export function skipPatternsFor(ruleId, auditIgnore, ruleSkips) {
  const fromIgnore = auditIgnore.filter((e) => e.ruleId === ruleId).map((e) => e.pattern);
  return [...fromIgnore, ...(ruleSkips ?? [])];
}

export function toRepoRelative(repoRoot, abs) {
  return relative(repoRoot, abs).split(sep).join(posix.sep);
}

export function compilePatterns(patterns, flags = 'gi') {
  return patterns.map((p) => {
    try {
      return new RegExp(p, flags);
    } catch {
      const escaped = p.replace(/[.+^$|()\[\]\\{}*?]/g, (m) => `\\${m}`);
      return new RegExp(escaped, flags);
    }
  });
}

export function excerpt(text, index, length, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const before = text.slice(start, index);
  const middle = text.slice(index, index + length);
  const after = text.slice(index + length, end);
  return `${start > 0 ? '…' : ''}${before}«${middle}»${after}${end < text.length ? '…' : ''}`.replace(
    /\s+/g,
    ' ',
  );
}
