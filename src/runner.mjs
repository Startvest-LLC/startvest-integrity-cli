// Rule executor. Five check kinds, deterministic, no LLM, no network.
//
//   - forbidden-regex   — fail when any pattern matches in any file under globs.
//   - required-regex    — fail when no/all patterns match (matchAny / matchAll).
//   - file-exists-any   — fail when none of the listed paths is a real file.
//   - co-occurrence     — content-based: if any `trigger` pattern matches in
//                         any scanned file, require at least one `required`
//                         pattern to match somewhere in the scanned corpus.
//                         Vacuous-pass when no trigger fires. Designed to
//                         catch corpus-level patterns like "any code that
//                         imports an AI SDK must record a review-gate marker
//                         somewhere", without false-negativing on layered
//                         architectures where the trigger and the marker
//                         live in different files.
//   - integrity-md-claims
//                       — two-tier check on INTEGRITY.md Recent Changes:
//                         (1) structural lint — every dated entry must
//                         contain a file path, commit hash, or #PR ref;
//                         (2) runnable assertions — entries with high-value
//                         claim phrasings (link/marker/exemption/Trust
//                         Principles) require a matching assertion in
//                         audits/integrity-claims.json that returns true.
//                         Strikethrough text (~~...~~) is treated as
//                         retracted and stripped before evaluation.
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
    case 'co-occurrence':
      scan = await coOccurrenceScan(rule, root, skipPatterns);
      break;
    case 'integrity-md-claims':
      scan = await integrityMdClaimsScan(rule, root);
      break;
    case 'manifest-meta':
      // Meta rules are enforced at manifest-merge time by the CLI, not by
      // the file scanner. If one reaches the runner, treat it as a skipped
      // pass — the CLI is responsible for synthesizing the actual result.
      return {
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        passed: true,
        skipped: true,
        skipReason: 'manifest-meta rule (enforced at merge time, not file scan)',
        findings: [],
      };
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

async function coOccurrenceScan(rule, root, skipPatterns) {
  // Shape:
  //   check.kind = 'co-occurrence'
  //   check.globs = files to scan
  //   check.trigger.patterns = if any of these match anywhere, the rule activates
  //   check.required.patterns = at least one must match somewhere in the
  //                             scanned corpus when triggered
  //
  // Vacuous-pass when zero scannable files OR no trigger fires.
  if (!rule.check.globs || !rule.check.trigger?.patterns || !rule.check.required?.patterns) {
    return { findings: [] };
  }
  const files = await findFiles(root, rule.check.globs);
  const scannable = files.filter((abs) => !matchesAnyGlob(toRepoRelative(root, abs), skipPatterns));
  if (scannable.length === 0) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `no files matched globs: ${rule.check.globs.join(', ')}`,
    };
  }

  const triggerRegexes = compilePatterns(rule.check.trigger.patterns, 'g');
  const requiredRegexes = compilePatterns(rule.check.required.patterns, 'g');

  let triggered = false;
  let triggerLocations = [];
  let requiredHit = false;

  for (const abs of scannable) {
    const text = await readFileSafe(abs);
    if (text === null) continue;
    const rel = toRepoRelative(root, abs);
    if (!triggered) {
      for (const re of triggerRegexes) {
        re.lastIndex = 0;
        if (re.test(text)) {
          triggered = true;
          triggerLocations.push(rel);
          break;
        }
      }
    }
    if (!requiredHit) {
      for (const re of requiredRegexes) {
        re.lastIndex = 0;
        if (re.test(text)) {
          requiredHit = true;
          break;
        }
      }
    }
    if (triggered && requiredHit) break;
  }

  if (!triggered) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `no trigger pattern fired (rule inactive in this repo)`,
    };
  }
  if (requiredHit) return { findings: [] };

  return {
    findings: [
      baseFinding(rule, {
        location: triggerLocations.slice(0, 3).join(', ') + (triggerLocations.length > 3 ? ', ...' : ''),
        found: `trigger fired (e.g. ${rule.check.trigger.patterns[0]}) but no required marker found anywhere in corpus: ${rule.check.required.patterns.join(' | ')}`,
      }),
    ],
  };
}

async function integrityMdClaimsScan(rule, root) {
  // Reads INTEGRITY.md (configurable). Scans one or more configured
  // sections. Each section has a policy:
  //
  //   - "claim-presence" (default; for Recent Changes):
  //       Each dated entry must (a) carry a structural reference, or
  //       (b) for high-value claim phrasings (link/marker/exemption/
  //       Trust Principles), reference a sidecar assertion that passes.
  //       Strikethrough text (~~...~~) is stripped first.
  //
  //   - "claim-absence" (for Outstanding Risks / Known Gaps):
  //       Each entry that asserts something is missing/not implemented/
  //       not in place must reference a file path or marker the rule
  //       can verify is genuinely absent. Either a file-not-contains/
  //       file-not-exists sidecar assertion (runnable verification, ideal),
  //       or a structural reference (file path, #N ticket, etc.) that a
  //       reader can check by hand. Strikethrough is stripped.
  //
  // Vacuous-pass when INTEGRITY.md is missing or none of the configured
  // sections are present.
  const integrityMdPath = rule.check.integrityMdPath ?? 'INTEGRITY.md';
  const sidecarPath = rule.check.claimsSidecarPath ?? 'audits/integrity-claims.json';
  const highValuePatterns = rule.check.highValueClaimPatterns ?? DEFAULT_HIGH_VALUE_PATTERNS;
  const absencePatterns = rule.check.absenceClaimPatterns ?? DEFAULT_ABSENCE_PATTERNS;

  // Backwards-compat: if `sections` is not provided, fall back to a single
  // section using `recentChangesHeading` (default: "Recent Changes") with
  // the claim-presence policy.
  let sections = rule.check.sections;
  if (!sections) {
    sections = [
      {
        heading: rule.check.recentChangesHeading ?? 'Recent Changes',
        policy: 'claim-presence',
      },
    ];
  }

  const integrityMdAbs = resolve(root, integrityMdPath);
  const integrityText = await readFileSafe(integrityMdAbs);
  if (integrityText === null) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `${integrityMdPath} not found`,
    };
  }

  const sidecarAbs = resolve(root, sidecarPath);
  const sidecarText = await readFileSafe(sidecarAbs);
  let sidecar = null;
  if (sidecarText !== null) {
    try {
      sidecar = JSON.parse(sidecarText);
    } catch (err) {
      return {
        findings: [
          baseFinding(rule, {
            location: sidecarPath,
            found: `failed to parse sidecar: ${err.message}`,
          }),
        ],
      };
    }
  }

  const highValueCompiled = compilePatterns(highValuePatterns, 'i');
  const structuralCompiled = compilePatterns(STRUCTURAL_REFERENCE_PATTERNS, 'i');
  const absenceCompiled = compilePatterns(absencePatterns, 'i');

  const findings = [];
  let anySectionPresent = false;
  let anyEntriesProcessed = false;

  for (const section of sections) {
    const sectionText = extractSection(integrityText, section.heading);
    if (!sectionText) continue;
    anySectionPresent = true;
    const policy = section.policy ?? 'claim-presence';

    let entries;
    if (policy === 'claim-absence') {
      entries = parseBulletEntries(sectionText);
    } else {
      entries = parseDatedEntries(sectionText);
    }

    for (const entry of entries) {
      anyEntriesProcessed = true;
      const body = stripStrikethrough(entry.body).trim();
      if (body.length === 0) continue;

      const locationLabel = entry.date
        ? `${integrityMdPath} § ${section.heading}: ${entry.date}`
        : `${integrityMdPath} § ${section.heading}: ${entry.firstLine}`;

      if (policy === 'claim-absence') {
        const matched = matchFirst(absenceCompiled, body);
        if (!matched) {
          // Non-absence entry in Outstanding Risks → structural lint only
          // (reader needs a way to check that the gap is real).
          if (!matchAny(structuralCompiled, body)) {
            findings.push(
              baseFinding(rule, {
                location: locationLabel,
                found: `entry lacks a structural reference (file path / commit hash / #N ticket). Add one so a reader can verify the gap is real.`,
              }),
            );
          }
          continue;
        }
        // Absence claim → prefer runnable sidecar assertion; accept
        // structural reference as fallback.
        const sidecarMatches = findSidecarAssertionsForEntry(sidecar, entry, section.heading);
        if (sidecarMatches.length > 0) {
          for (const claim of sidecarMatches) {
            const result = await runClaimAssertion(claim, root);
            if (!result.ok) {
              findings.push(
                baseFinding(rule, {
                  location: `${locationLabel} (sidecar assertion)`,
                  found: `absence claim contradicted by code reality (reverse drift) — ${result.reason}`,
                }),
              );
            }
          }
          continue;
        }
        if (!matchAny(structuralCompiled, body)) {
          findings.push(
            baseFinding(rule, {
              location: locationLabel,
              found: `absence claim ("${matched.source}") needs a verifiable reference: either a sidecar assertion (file-not-contains / file-not-exists) in ${sidecarPath}, or a structural marker (file path, #N ticket) so a reader can check that the gap is real.`,
            }),
          );
        }
        continue;
      }

      // claim-presence policy (Recent Changes)
      const highValueMatch = matchFirst(highValueCompiled, body);
      if (highValueMatch) {
        const sidecarMatches = findSidecarAssertionsForEntry(sidecar, entry, section.heading);
        if (sidecarMatches.length === 0) {
          findings.push(
            baseFinding(rule, {
              location: locationLabel,
              found: `high-value claim ("${highValueMatch.source}") requires assertion in ${sidecarPath}, none found`,
            }),
          );
          continue;
        }
        for (const claim of sidecarMatches) {
          const result = await runClaimAssertion(claim, root);
          if (!result.ok) {
            findings.push(
              baseFinding(rule, {
                location: `${locationLabel} (sidecar assertion)`,
                found: `assertion failed — ${result.reason}`,
              }),
            );
          }
        }
        continue;
      }

      if (!matchAny(structuralCompiled, body)) {
        findings.push(
          baseFinding(rule, {
            location: locationLabel,
            found: `entry lacks a structural reference (file path / commit hash / #N issue or PR ref). Add one, or convert the claim to a high-value claim with an assertion in ${sidecarPath}.`,
          }),
        );
      }
    }
  }

  if (!anySectionPresent) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `none of the configured sections (${sections.map((s) => `"${s.heading}"`).join(', ')}) found in ${integrityMdPath}`,
    };
  }
  if (!anyEntriesProcessed) {
    return {
      findings: [],
      vacuous: true,
      vacuousReason: `configured sections exist but contain no parseable entries`,
    };
  }

  return { findings };
}

function matchFirst(regexes, text) {
  for (const re of regexes) {
    re.lastIndex = 0;
    if (re.test(text)) return re;
  }
  return null;
}

function matchAny(regexes, text) {
  for (const re of regexes) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

function findSidecarAssertionsForEntry(sidecar, entry, sectionHeading) {
  if (!sidecar || !Array.isArray(sidecar.claims)) return [];
  return sidecar.claims.filter((c) => {
    if (c.section && sectionHeading && c.section !== sectionHeading) return false;
    if (entry.date && c.date && c.date === entry.date) return true;
    if (c.claim && entry.body && entry.body.toLowerCase().includes(c.claim.toLowerCase())) return true;
    return false;
  });
}

const DEFAULT_HIGH_VALUE_PATTERNS = [
  '\\b(link|links)\\s+(added|present|surfaced|included|placed)',
  '\\bsurfaced\\s+in\\b',
  '\\b(linked|points)\\s+(to|from)\\b',
  '\\bmarker\\s+(added|present|recorded|attached)',
  '\\bcolumn\\s+(added|shipped|present)',
  '\\.auditignore\\s+exempts?\\b',
  '\\bexemption\\s+(added|present)',
  '\\b[Tt]rust\\s+[Pp]rinciples\\b',
];

const DEFAULT_ABSENCE_PATTERNS = [
  // Leading "No X" / "no public link" / "no formal Y"
  // Word-boundary based so it matches "**No public link" (markdown bold) too.
  '\\b[Nn]o\\s+(?:public|formal|external|explicit|customer|automated|dedicated|specific|identified)?\\s*(?:link|review|gate|policy|disclosure|process|role|standard|threshold|community|operational|page|surface|workflow|formal\\s+\\w+)',
  // Generic "missing"
  '\\bmissing\\b',
  // "not implemented" / "not in place" / "not yet X"
  '\\bnot\\s+(?:yet|fully)?\\s*(?:implemented|in\\s+place|operational|shipped|published|ratified|finalized|finalised|provisioned|enforced|wired|landed|enforced)',
  // "X is/are absent" / "no X is present"
  '\\bis\\s+(?:not|absent)\\b',
  '\\bare\\s+(?:not|absent)\\b',
  // Specific MSA / contract / clause variants
  '\\bclause\\s+missing\\b',
  '\\bnot\\s+in\\s+(?:current|standard)\\s+MSA\\b',
  // "X deferred" (e.g. annual audit deferred pending funding)
  '\\bdeferred\\s+pending\\b',
  // "X needs update" / "needs to be"
  '\\bneeds?\\s+(?:update|to\\s+be)\\b',
];

const STRUCTURAL_REFERENCE_PATTERNS = [
  // File paths under common project roots
  '\\b(?:src|app|lib|services|sql|audits|docs|test|tests|public|content|scripts|infra|dev-tools|manifests|bin)/[^\\s)`\\]"\']+',
  // Commit hashes (7-40 hex)
  '\\b[a-f0-9]{7,40}\\b',
  // Issue / PR references
  '(?:^|\\s|\\()#\\d+\\b',
  '\\b(?:PR|pull\\s+request|issue|ticket)\\s+#?\\d+\\b',
  // Version tags
  '\\bv\\d+\\.\\d+(?:\\.\\d+)?\\b',
  // File names in code spans (with extension)
  '`[^`\\n]+\\.(?:ts|tsx|js|jsx|mjs|json|md|sql|yaml|yml|tf|css|html)`',
  // Markdown links [label](url)
  '\\[[^\\]\\n]+\\]\\([^)]+\\)',
  // Slash-prefixed public routes (e.g. /methodology, /privacy, /service-standards)
  '(?:^|[\\s(`])/[a-z][\\w-]*(?:/[\\w-]+)*',
  // Common top-level project files referenced by name
  '\\b(?:INTEGRITY\\.md|CLAUDE\\.md|AGENTS\\.md|README\\.md|CHANGELOG\\.md|LICENSE)\\b',
  // Backtick-wrapped top-level project files
  '`(?:INTEGRITY\\.md|CLAUDE\\.md|AGENTS\\.md|README\\.md|CHANGELOG\\.md|LICENSE)`',
  // Database / entity table names with product-prefix (e.g. FieldLedger_RateLetters)
  '\\b[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\\b',
];

function extractSection(text, heading) {
  // Find "## <heading>" line, return content until next "## " line or EOF.
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const nextSectionMatch = /^##\s+/m.exec(remainder);
  return nextSectionMatch ? remainder.slice(0, nextSectionMatch.index) : remainder;
}

function parseDatedEntries(sectionText) {
  // Match `- **YYYY-MM-DD**` entries. Each entry runs from its line until
  // the next entry-start or EOF. Multi-line bullets are supported.
  const lines = sectionText.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)[-*]\s+(?:~~)?\*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = { date: m[2], body: line, firstLine: line.slice(0, 100), lineStart: i };
    } else if (current) {
      if (/^\s*[-*]\s/.test(line)) {
        entries.push(current);
        current = null;
      } else {
        current.body += '\n' + line;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

function parseBulletEntries(sectionText) {
  // Match generic top-level bullet entries (`- ...` or `* ...`). Each entry
  // runs from its line until the next sibling bullet or EOF. Multi-line
  // continuations are concatenated. Used for Outstanding Risks-style
  // sections where entries are not date-anchored.
  const lines = sectionText.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s{0,3})[-*]\s+/.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = {
        date: null,
        body: line,
        firstLine: line.slice(0, 100),
        lineStart: i,
      };
    } else if (current) {
      // Continuation only when not a new top-level bullet at the same indent
      if (line.match(/^\s{0,3}[-*]\s/)) {
        entries.push(current);
        current = null;
      } else {
        current.body += '\n' + line;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

function stripStrikethrough(text) {
  // Remove ~~...~~ spans (single-line and multi-line non-greedy).
  return text.replace(/~~[\s\S]+?~~/g, '');
}

async function runClaimAssertion(claim, root) {
  const a = claim.assertion;
  const claimLabel = claim.summary ?? claim.claim ?? claim.date ?? '(unlabeled)';
  if (!a || !a.kind) return { ok: false, reason: `claim "${claimLabel}" has no assertion.kind` };
  if (a.kind === 'file-contains') {
    const abs = resolve(root, a.path);
    const text = await readFileSafe(abs);
    if (text === null) {
      return { ok: false, reason: `file-contains: target path ${a.path} not found` };
    }
    const re = new RegExp(a.pattern);
    if (re.test(text)) return { ok: true };
    return { ok: false, reason: `file-contains: ${a.path} does not match /${a.pattern}/ (claim: "${claimLabel}")` };
  }
  if (a.kind === 'file-not-contains') {
    const abs = resolve(root, a.path);
    const text = await readFileSafe(abs);
    if (text === null) return { ok: true };
    const re = new RegExp(a.pattern);
    if (!re.test(text)) return { ok: true };
    return { ok: false, reason: `file-not-contains: ${a.path} matches /${a.pattern}/ — pattern IS present (reverse drift; claim: "${claimLabel}")` };
  }
  if (a.kind === 'file-exists') {
    const abs = resolve(root, a.path);
    if (await fileExists(abs)) return { ok: true };
    return { ok: false, reason: `file-exists: ${a.path} does not exist (claim: "${claimLabel}")` };
  }
  if (a.kind === 'file-not-exists') {
    const abs = resolve(root, a.path);
    if (!(await fileExists(abs))) return { ok: true };
    return { ok: false, reason: `file-not-exists: ${a.path} exists — pattern IS present (reverse drift; claim: "${claimLabel}")` };
  }
  return { ok: false, reason: `unknown assertion.kind: ${a.kind}` };
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
