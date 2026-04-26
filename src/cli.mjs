// CLI entry. Subcommands:
//
//   integrity check <repo>     Run base + per-product manifests, report results.
//   integrity verify <repo>    Confirm the per-product manifest covers all base
//                              v1.0 required rule ids (no rule execution).
//   integrity rules            Print the base manifest as JSON (citable).
//
// Flags (check):
//   --format=human|json        Output format. Default: human.
//   --strict                   Exit non-zero on HIGH failures too. Default: only
//                              CRITICAL fails.
//   --base-only                Skip per-product manifests; run base only.
//   --no-base                  Skip base; run per-product only.

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRules } from './runner.mjs';
import { buildEffectiveRules, loadBaseManifest, verifyBaseCoverage } from './manifest.mjs';
import { renderHuman } from './report-human.mjs';
import { runDirectory } from './directory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEVERITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

function parseFlags(argv) {
  const out = {
    format: 'human',
    strict: false,
    baseOnly: false,
    noBase: false,
    repo: null,
  };
  const positional = [];
  for (const a of argv) {
    if (a === '--strict') out.strict = true;
    else if (a === '--base-only') out.baseOnly = true;
    else if (a === '--no-base') out.noBase = true;
    else if (a === '--json') out.format = 'json';
    else if (a === '--human') out.format = 'human';
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a.startsWith('--repo=')) out.repo = a.slice('--repo='.length);
    else if (a.startsWith('--')) {
      // unknown long flag; ignore for forward compatibility
    } else positional.push(a);
  }
  if (!out.repo && positional.length > 0) out.repo = positional[0];
  return { flags: out, positional };
}

function usage() {
  return [
    'Usage:',
    '  integrity check <repo> [--format=human|json] [--strict] [--base-only] [--no-base]',
    '  integrity verify <repo> [--format=human|json]',
    '  integrity rules',
    '  integrity directory <list|show|validate|submit> ...',
    '  integrity --version',
    '',
    'check / verify / rules:',
    '  Reads <repo>/audits/rules/*.json and runs the base',
    "  Startvest Integrity Framework v1.0 manifest plus the repo's own rules.",
    '',
    'directory:',
    '  Browse and submit listings for the Integrity Framework Directory at',
    '  https://theintegrityframework.org. See "integrity directory --help".',
    '',
    'Exit codes:',
    '  0  ok',
    '  1  one or more CRITICAL findings / validation failed / not found',
    '  2  one or more HIGH findings (only when --strict) / network error',
    '  3  usage error',
  ].join('\n');
}

async function readPkgVersion() {
  try {
    const path = resolve(__dirname, '..', 'package.json');
    const text = await readFile(path, 'utf8');
    return JSON.parse(text).version;
  } catch {
    return 'unknown';
  }
}

export async function run(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${await readPkgVersion()}\n`);
    return 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === 'rules') {
    const base = await loadBaseManifest();
    process.stdout.write(`${JSON.stringify(base, null, 2)}\n`);
    return 0;
  }

  if (sub === 'check') return cmdCheck(rest);
  if (sub === 'verify') return cmdVerify(rest);
  if (sub === 'directory') return runDirectory(rest);

  process.stderr.write(`integrity: unknown command "${sub}"\n${usage()}\n`);
  return 3;
}

async function cmdCheck(argv) {
  const { flags } = parseFlags(argv);
  if (!flags.repo) {
    process.stderr.write('integrity check: <repo> is required\n');
    return 3;
  }
  const repoRoot = resolve(flags.repo);

  const { effective, base, sources, repoFiles } = await buildEffectiveRules({
    repoRoot,
    baseOnly: flags.baseOnly,
    includeBase: !flags.noBase,
  });

  if (effective.length === 0) {
    process.stderr.write(`integrity check: no rules loaded for ${repoRoot}\n`);
    return 3;
  }

  const results = await runRules(effective, repoRoot);
  const counts = countBySeverity(results);

  if (flags.format === 'json') {
    const payload = {
      framework: 'Startvest Integrity Framework',
      baseVersion: base.version,
      repoRoot,
      sources: { base: !flags.noBase, repoManifests: repoFiles },
      counts,
      results,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const text = renderHuman({
      results,
      repoRoot,
      baseVersion: base.version,
      sources,
    });
    process.stdout.write(`${text}\n`);
  }

  if (counts.CRITICAL > 0) return 1;
  if (flags.strict && counts.HIGH > 0) return 2;
  return 0;
}

async function cmdVerify(argv) {
  const { flags } = parseFlags(argv);
  if (!flags.repo) {
    process.stderr.write('integrity verify: <repo> is required\n');
    return 3;
  }
  const repoRoot = resolve(flags.repo);
  const result = await verifyBaseCoverage(repoRoot);

  if (flags.format === 'json') {
    process.stdout.write(`${JSON.stringify({ repoRoot, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(`Startvest Integrity Framework v${result.baseVersion}\n`);
    process.stdout.write(`Repo: ${repoRoot}\n`);
    process.stdout.write(`Present: ${result.present.length}/${result.present.length + result.missing.length} required base rules\n`);
    if (result.missing.length > 0) {
      process.stdout.write(`Missing rule ids:\n`);
      for (const id of result.missing) process.stdout.write(`  - ${id}\n`);
    } else {
      process.stdout.write(`All required base rule ids covered.\n`);
    }
  }

  return result.missing.length === 0 ? 0 : 1;
}

function countBySeverity(results) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const r of results) {
    if (!r.passed) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
  }
  return counts;
}
