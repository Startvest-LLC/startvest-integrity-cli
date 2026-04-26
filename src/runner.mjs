// Rule executor. Three check kinds, deterministic, no LLM, no network.
//
//   - forbidden-regex   — fail when any pattern matches in any file under globs.
//   - required-regex    — fail when no/all patterns match (matchAny / matchAll).
//   - file-exists-any   — fail when none of the listed paths is a real file.
//
// Schema is the one canonised by ClarityLift's audits/rules — adopted across
// every Startvest product so the standalone runner can read any product's
// rules file as-is.
//
// Honest-reporting note: when no candidate files match the rule's globs, the
// runner reports `vacuous: true`. A "pass" never silently means "we didn't
// actually check anything" — vacuous passes are visible in both human and
// JSON output so a buyer reading a report can tell.

import { resolve } from 'node:path';
import {
  findFiles,
  readFileSafe,
  fileExists,
  readAuditIgnore,
  skipPatternsFor,
  matchesAnyGlob,
  toRepoRelative,
  compilePatterns,
  excerpt,
} from './lib.mjs';

export async function runRules(rules, repoRoot) {
  const root = resolve(repoRoot);
  const auditIgnore = await readAuditIgnore(root);
  const out = [];
  for (const rule of rules) {
    out.push(await runRule(rule, root, auditIgnore));
  }
  return out;
}

async function runRule(rule, root, auditIgnore) {
  if (!rule.check) {
    return {
      ruleId: rule.id,
      severity: rule.severity,
      title: rule.title,
      passed: true,
      skipped: true,
      skipReason: 'no architectural check (marketing/content rule)',
      findings: [],
    };
  }

  const skipPatterns = skipPatternsFor(
    rule.id,
    auditIgnore,
    rule.check.skipFiles ?? rule.check.skipGlobs,
  );

  let scan;
  switch (rule.check.kind) {
    case 'forbidden-regex':
    case 'forbidden-literal':
      scan = await forbiddenScan(rule, root, skipPatterns);
      break;
    case 'required-regex':
    case 'required-literal':
      scan = await requiredScan(rule, root, skipPatterns);
      break;
    case 'file-exists-any':
      scan = await fileExistsAnyCheck(rule, root);
      break;
    default:
      scan = {
        findings: [
          baseFinding(rule, {
            location: rule.id,
            found: `unknown check.kind: ${rule.check.kind}`,
          }),
        ],
      };
  }

  const result = {
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    passed: scan.findings.length === 0,
    findings: scan.findings,
  };
  if (scan.vacuous) {
    result.vacuous = true;
    result.vacuousReason = scan.vacuousReason;
  }
  return result;
}

function baseFinding(rule, extras) {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    why: rule.why,
    fix: rule.fix,
    researchCitation: rule.researchCitation,
    ...extras,
  };
}

async function forbiddenScan(rule, root, skipPatterns) {
  if (!rule.check.globs || !rule.check.patterns) return { findings: [] };
  const files = await findFiles(root, rule.check.globs);
  const scannable = files.filter((abs) => !matchesAnyGlob(toRepoRelative(root, abs), skipPatterns));
  // forbidden-regex stays case-sensitive: code patterns like "verified: true"
  // mean a literal property, and TypeScript/JS property names are
  // case-sensitive. Case-insensitive widens the surface to test data and
  // user-facing copy that isn't actually a forbidden code construct.
  const regexes = compilePatterns(rule.check.patterns, 'g');
  const findings = [];
  for (const abs of scannable) {
    const rel = toRepoRelative(root, abs);
    const text = await readFileSafe(abs);
    if (text === null) continue;
    for (const re of regexes) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(
          baseFinding(rule, {
            location: `${rel}:${line}`,
            found: excerpt(text, match.index, match[0].length, 40),
          }),
        );
        if (!re.global) break;
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  if (scannable.length === 0) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `no files matched globs: ${rule.check.globs.join(', ')}`,
    };
  }
  return { findings };
}

async function requiredScan(rule, root, skipPatterns) {
  if (!rule.check.globs || !rule.check.patterns) return { findings: [] };
  const files = await findFiles(root, rule.check.globs);
  const scannable = files.filter((abs) => !matchesAnyGlob(toRepoRelative(root, abs), skipPatterns));

  if (scannable.length === 0) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `no files matched globs: ${rule.check.globs.join(', ')}`,
    };
  }

  const regexes = compilePatterns(rule.check.patterns, 'gi');
  const patternHits = new Array(regexes.length).fill(0);

  for (const abs of scannable) {
    const text = await readFileSafe(abs);
    if (text === null) continue;
    regexes.forEach((re, i) => {
      re.lastIndex = 0;
      if (re.test(text)) patternHits[i]++;
    });
  }

  const matchAll = rule.check.matchAll === true;
  const matchAny = rule.check.matchAny === true || !matchAll;

  const missing = [];
  regexes.forEach((re, i) => {
    if (patternHits[i] === 0) missing.push(rule.check.patterns[i]);
  });

  let failed = false;
  if (matchAll) failed = missing.length > 0;
  else if (matchAny) failed = missing.length === regexes.length;
  if (!failed) return { findings: [] };

  return {
    findings: [
      baseFinding(rule, {
        location: rule.check.globs.join(', '),
        found: matchAll
          ? `missing required patterns: ${missing.join(', ')}`
          : `none of these matched anywhere: ${rule.check.patterns.join(' | ')}`,
      }),
    ],
  };
}

async function fileExistsAnyCheck(rule, root) {
  if (!rule.check.paths || rule.check.paths.length === 0) return { findings: [] };
  for (const p of rule.check.paths) {
    if (await fileExists(resolve(root, p))) return { findings: [] };
  }
  return {
    findings: [
      baseFinding(rule, {
        location: rule.check.paths.join(' | '),
        found: `no file found at any of: ${rule.check.paths.join(', ')}`,
      }),
    ],
  };
}
