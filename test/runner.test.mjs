// Smoke test: drive the CLI runner against a fixture repo and assert each
// rule kind behaves the way the framework promises. No test framework — plain
// asserts so the test runs with `node test/runner.test.mjs`.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { runRules } from '../src/runner.mjs';
import { buildEffectiveRules, verifyBaseCoverage } from '../src/manifest.mjs';

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'integrity-test-'));
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await mkdir(join(root, 'audits', 'rules'), { recursive: true });
  return root;
}

async function testFileExistsAny() {
  const root = await makeRepo();
  try {
    const rules = [
      {
        id: 'TEST-EXISTS',
        severity: 'HIGH',
        title: 'INTEGRITY.md exists',
        why: 'baseline',
        fix: 'add INTEGRITY.md',
        researchCitation: 'test',
        check: { kind: 'file-exists-any', paths: ['INTEGRITY.md'] },
      },
    ];

    let results = await runRules(rules, root);
    assert.equal(results[0].passed, false, 'should fail when file is missing');

    await writeFile(join(root, 'INTEGRITY.md'), '# integrity\n');
    results = await runRules(rules, root);
    assert.equal(results[0].passed, true, 'should pass when file exists');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testForbiddenRegex() {
  const root = await makeRepo();
  try {
    const file = join(root, 'src', 'lib', 'compliance.ts');
    await writeFile(
      file,
      "function check(x) { try { return x } catch (e) { return { verified: true } } }\n",
    );
    const rules = [
      {
        id: 'TEST-NOSILENT',
        severity: 'CRITICAL',
        title: 'no silent pass',
        why: 'failure transparency',
        fix: 'do not return verified=true from catch',
        researchCitation: 'test',
        check: {
          kind: 'forbidden-regex',
          globs: ['src/**/*.ts'],
          patterns: ['catch\\s*\\([^)]*\\)\\s*\\{[^}]{0,400}verified\\s*:\\s*true'],
        },
      },
    ];

    let results = await runRules(rules, root);
    assert.equal(results[0].passed, false);
    assert.match(results[0].findings[0].location, /compliance\.ts:\d+/);

    // Replace the offending block with a safe version.
    await writeFile(file, "function check(x) { try { return x } catch { return { verified: false } } }\n");
    results = await runRules(rules, root);
    assert.equal(results[0].passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRequiredRegexVacuous() {
  const root = await makeRepo();
  try {
    const rules = [
      {
        id: 'TEST-METHOD',
        severity: 'HIGH',
        title: 'methodology versioned',
        why: 'no hidden methodology',
        fix: 'add ## Version + ## Changelog',
        researchCitation: 'test',
        check: {
          kind: 'required-regex',
          globs: ['src/app/methodology/**/*.{tsx,mdx,md}'],
          patterns: ['##\\s*Version', '##\\s*Changelog'],
          matchAll: true,
        },
      },
    ];

    let results = await runRules(rules, root);
    assert.equal(results[0].passed, true, 'vacuous-pass when no candidate files exist');

    await mkdir(join(root, 'src', 'app', 'methodology'), { recursive: true });
    await writeFile(join(root, 'src', 'app', 'methodology', 'page.mdx'), '# methodology\n');
    results = await runRules(rules, root);
    assert.equal(results[0].passed, false, 'fails when page exists but lacks headings');

    await writeFile(
      join(root, 'src', 'app', 'methodology', 'page.mdx'),
      '# methodology\n\n## Version\n\nv1.0\n\n## Changelog\n\n- v1.0 first cut\n',
    );
    results = await runRules(rules, root);
    assert.equal(results[0].passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testManifestMerge() {
  const root = await makeRepo();
  try {
    await writeFile(join(root, 'INTEGRITY.md'), '# integrity\n');
    await writeFile(
      join(root, 'audits', 'rules', 'architectural-rules.json'),
      JSON.stringify(
        {
          version: '0.1.0',
          rules: [
            {
              id: 'PROD-X',
              severity: 'INFO',
              title: 'product specific',
              why: 'extension example',
              fix: '-',
              researchCitation: 'test',
              check: { kind: 'file-exists-any', paths: ['nonexistent.txt'] },
            },
          ],
        },
        null,
        2,
      ),
    );

    const { effective } = await buildEffectiveRules({ repoRoot: root });
    const ids = effective.map((r) => r.id);
    assert.ok(ids.includes('HIGH-SV-INTEGRITY-MD'), 'base rule present');
    assert.ok(ids.includes('PROD-X'), 'product rule merged');

    const verify = await verifyBaseCoverage(root);
    assert.ok(
      verify.missing.length > 0,
      'verify reports missing base ids when product manifest does not redeclare them',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIntegrityMdClaimsCatchesClarityLiftDrift() {
  // Reproduces the ClarityLift 2026-04-28 drift case study. INTEGRITY.md
  // claims a Trust Principles link was added to PrivacyClient.tsx; the file
  // exists but doesn't contain the link. Sidecar assertion targets the
  // file. The rule must FAIL — drift caught before the next audit.
  const root = await makeRepo();
  try {
    await mkdir(join(root, 'src', 'app', 'privacy'), { recursive: true });
    await mkdir(join(root, 'audits'), { recursive: true });

    await writeFile(
      join(root, 'INTEGRITY.md'),
      [
        '# Integrity Statement: Test',
        '',
        'Last reviewed: 2026-04-25',
        '',
        '## Recent Changes',
        '',
        '- **2026-04-25** — Trust Principles link added to `/privacy` and `integrity@startvest.ai` surfaced in marketing footer.',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(root, 'src', 'app', 'privacy', 'PrivacyClient.tsx'),
      'export default function PrivacyClient() { return <div>Privacy posture</div>; }\n',
    );

    await writeFile(
      join(root, 'audits', 'integrity-claims.json'),
      JSON.stringify(
        {
          version: '1.0',
          claims: [
            {
              date: '2026-04-25',
              summary: 'Trust Principles link in PrivacyClient',
              assertion: {
                kind: 'file-contains',
                path: 'src/app/privacy/PrivacyClient.tsx',
                pattern: 'trust-principles|startvest\\.ai/trust',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const rule = {
      id: 'TEST-INTEGRITY-MD-CLAIMS',
      severity: 'HIGH',
      title: 'integrity-md-claims test',
      why: 'catch documentation drift',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'integrity-md-claims',
        integrityMdPath: 'INTEGRITY.md',
        claimsSidecarPath: 'audits/integrity-claims.json',
        recentChangesHeading: 'Recent Changes',
      },
    };

    const results = await runRules([rule], root);
    assert.equal(results[0].passed, false, 'should FAIL when sidecar assertion does not match code reality');
    const finding = results[0].findings.find((f) => /assertion failed/.test(f.found));
    assert.ok(finding, 'finding should report assertion failure');
    assert.match(finding.found, /trust-principles/i, 'failure should mention the missing pattern');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIntegrityMdClaimsPassesAfterFix() {
  // Same shape as the drift test, but PrivacyClient.tsx now contains the
  // Trust Principles link. Assertion passes; rule passes.
  const root = await makeRepo();
  try {
    await mkdir(join(root, 'src', 'app', 'privacy'), { recursive: true });
    await mkdir(join(root, 'audits'), { recursive: true });

    await writeFile(
      join(root, 'INTEGRITY.md'),
      [
        '# Integrity Statement: Test',
        '',
        '## Recent Changes',
        '',
        '- **2026-04-25** — Trust Principles link added to `/privacy` and `integrity@startvest.ai` surfaced in marketing footer.',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(root, 'src', 'app', 'privacy', 'PrivacyClient.tsx'),
      'export default function PrivacyClient() { return <a href="https://startvest.ai/trust-principles">Trust Principles</a>; }\n',
    );

    await writeFile(
      join(root, 'audits', 'integrity-claims.json'),
      JSON.stringify(
        {
          version: '1.0',
          claims: [
            {
              date: '2026-04-25',
              summary: 'Trust Principles link in PrivacyClient',
              assertion: {
                kind: 'file-contains',
                path: 'src/app/privacy/PrivacyClient.tsx',
                pattern: 'trust-principles|startvest\\.ai/trust',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const rule = {
      id: 'TEST-INTEGRITY-MD-CLAIMS',
      severity: 'HIGH',
      title: 'integrity-md-claims test',
      why: 'validate fix',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'integrity-md-claims',
        integrityMdPath: 'INTEGRITY.md',
        claimsSidecarPath: 'audits/integrity-claims.json',
        recentChangesHeading: 'Recent Changes',
      },
    };

    const results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should PASS after the link is shipped to PrivacyClient');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIntegrityMdClaimsStructuralLint() {
  // Entry without any structural reference and no high-value pattern → FAIL.
  // Entry with a file path → PASS.
  // Entry whose claim is wrapped in strikethrough → skipped (not evaluated).
  const root = await makeRepo();
  try {
    await writeFile(
      join(root, 'INTEGRITY.md'),
      [
        '# Integrity Statement: Test',
        '',
        '## Recent Changes',
        '',
        '- **2026-04-25** — Tightened up the rate letter pipeline.',
        '- **2026-04-26** — Wired up new feature at `src/lib/foo.ts` and updated `audits/rules/architectural-rules.json`.',
        '- ~~**2026-04-22** — link added to old footer.~~ **CORRECTED 2026-04-29: not shipped, see #999.**',
        '',
      ].join('\n'),
    );

    const rule = {
      id: 'TEST-STRUCTURAL',
      severity: 'HIGH',
      title: 'structural lint',
      why: 'every entry must reference something concrete',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'integrity-md-claims',
        integrityMdPath: 'INTEGRITY.md',
        claimsSidecarPath: 'audits/integrity-claims.json',
        recentChangesHeading: 'Recent Changes',
      },
    };

    const results = await runRules([rule], root);
    assert.equal(results[0].passed, false, 'first entry has no structural ref → fail');
    const failures = results[0].findings.map((f) => f.location);
    assert.ok(
      failures.some((l) => /2026-04-25/.test(l)),
      'failure for 2026-04-25 (no ref)',
    );
    assert.ok(
      !failures.some((l) => /2026-04-26/.test(l)),
      '2026-04-26 has file paths → passes',
    );
    assert.ok(
      !failures.some((l) => /2026-04-22/.test(l)),
      '2026-04-22 entry is strikethrough-retracted; the CORRECTED note carries #999 → passes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCustomerAttestationValidationGate() {
  // ADA-shape positive test: trigger fires (conformanceStatus on a Statement
  // table) and validation gate is present in corpus → PASS.
  // Negative test: trigger fires + gate missing → FAIL.
  // Vacuous test: no trigger fires → PASS-vacuous.
  const root = await makeRepo();
  try {
    await mkdir(join(root, 'src', 'lib'), { recursive: true });

    const rule = {
      id: 'TEST-VALIDATION-GATE',
      severity: 'CRITICAL',
      title: 'validation gate test',
      why: 'C3 third axis',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'co-occurrence',
        globs: ['src/**/*.{ts,tsx,js,mjs}'],
        trigger: {
          patterns: [
            '\\b(?:conformance|compliance|attestation)Status\\b',
            'tableName\\s*:\\s*[\'"][^\'"]*Statement',
          ],
        },
        required: {
          patterns: [
            '\\b(?:check|validate|guard)(?:Conformance|Compliance|BeforePublish)\\b',
            '\\backnowledgeOpenFindings\\b',
            'checkConformanceGuard',
          ],
        },
      },
    };

    // Negative: schema declares conformanceStatus, no gate present.
    await writeFile(
      join(root, 'src', 'lib', 'schema.ts'),
      `export const StatementSchema = { tableName: 'Platform_Statements', columns: { conformanceStatus: { type: 'enum' } } };\n`,
    );
    let results = await runRules([rule], root);
    assert.equal(results[0].passed, false, 'should FAIL when status column declared but no gate present');

    // Positive: add the gate to a different file in the corpus.
    await writeFile(
      join(root, 'src', 'lib', 'statements.ts'),
      `export function checkConformanceGuard(orgId: string) { /* refuses 'full' if open findings */ }\n`,
    );
    results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should PASS when gate present somewhere in corpus');

    // Vacuous: remove the trigger entirely.
    await rm(join(root, 'src', 'lib', 'schema.ts'));
    results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should PASS vacuously when no trigger fires');
    assert.equal(results[0].vacuous, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIntegrityMdClaimsCatchesReverseDrift() {
  // Reproduces IdeaLift's 2026-04-29 reverse-drift case. INTEGRITY.md
  // Outstanding Risks claims a Trust Principles link is missing; the
  // file actually contains the link. Sidecar assertion uses file-not-contains
  // → assertion fails (link IS present) → reverse drift caught.
  const root = await makeRepo();
  try {
    await mkdir(join(root, 'apps', 'web', 'src', 'app', 'privacy'), { recursive: true });
    await mkdir(join(root, 'audits'), { recursive: true });

    await writeFile(
      join(root, 'INTEGRITY.md'),
      [
        '# Integrity Statement: Test',
        '',
        '## Outstanding Risks / Known Gaps',
        '',
        '- **No public link from product marketing → Startvest Trust Principles.** Add to footer once the page is published.',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(root, 'apps', 'web', 'src', 'app', 'privacy', 'page.tsx'),
      'export default function Privacy() { return <a href="https://startvest.ai/trust-principles">Trust Principles</a>; }\n',
    );

    await writeFile(
      join(root, 'audits', 'integrity-claims.json'),
      JSON.stringify(
        {
          version: '1.0',
          claims: [
            {
              section: 'Outstanding Risks / Known Gaps',
              claim: 'No public link from product marketing → Startvest Trust Principles',
              assertion: {
                kind: 'file-not-contains',
                path: 'apps/web/src/app/privacy/page.tsx',
                pattern: 'trust-principles|startvest\\.ai/trust',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const rule = {
      id: 'TEST-OUTSTANDING-RISKS-DRIFT',
      severity: 'HIGH',
      title: 'reverse drift catch',
      why: 'absence claims must remain true',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'integrity-md-claims',
        integrityMdPath: 'INTEGRITY.md',
        claimsSidecarPath: 'audits/integrity-claims.json',
        sections: [
          { heading: 'Outstanding Risks / Known Gaps', policy: 'claim-absence' },
        ],
      },
    };

    const results = await runRules([rule], root);
    assert.equal(results[0].passed, false, 'should FAIL — link IS present, reverse drift');
    const reverseDriftFinding = results[0].findings.find((f) => /reverse drift/.test(f.found));
    assert.ok(reverseDriftFinding, 'finding should mention reverse drift');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIntegrityMdClaimsAbsenceClaimVerified() {
  // The link is genuinely missing. file-not-contains assertion passes.
  // Rule passes.
  const root = await makeRepo();
  try {
    await mkdir(join(root, 'apps', 'web', 'src', 'app', 'privacy'), { recursive: true });
    await mkdir(join(root, 'audits'), { recursive: true });

    await writeFile(
      join(root, 'INTEGRITY.md'),
      [
        '# Integrity Statement: Test',
        '',
        '## Outstanding Risks / Known Gaps',
        '',
        '- **No public link from product marketing → Startvest Trust Principles.** Add to footer once the page is published.',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(root, 'apps', 'web', 'src', 'app', 'privacy', 'page.tsx'),
      'export default function Privacy() { return <div>Privacy posture</div>; }\n',
    );

    await writeFile(
      join(root, 'audits', 'integrity-claims.json'),
      JSON.stringify(
        {
          version: '1.0',
          claims: [
            {
              section: 'Outstanding Risks / Known Gaps',
              claim: 'No public link from product marketing → Startvest Trust Principles',
              assertion: {
                kind: 'file-not-contains',
                path: 'apps/web/src/app/privacy/page.tsx',
                pattern: 'trust-principles|startvest\\.ai/trust',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const rule = {
      id: 'TEST-OUTSTANDING-RISKS-VERIFIED',
      severity: 'HIGH',
      title: 'absence claim verified',
      why: 'absence is genuine',
      fix: '-',
      researchCitation: 'test',
      check: {
        kind: 'integrity-md-claims',
        integrityMdPath: 'INTEGRITY.md',
        claimsSidecarPath: 'audits/integrity-claims.json',
        sections: [
          { heading: 'Outstanding Risks / Known Gaps', policy: 'claim-absence' },
        ],
      },
    };

    const results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should PASS — link genuinely absent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCoOccurrence() {
  // Trigger fires (AI SDK import) but no required marker anywhere → fail.
  // Trigger fires + marker present somewhere → pass.
  // Trigger never fires → vacuous-pass.
  const root = await makeRepo();
  try {
    const libFile = join(root, 'src', 'lib', 'cpars.ts');
    await writeFile(
      libFile,
      "import Anthropic from '@anthropic-ai/sdk';\nexport function draft() { return ''; }\n",
    );

    const rule = {
      id: 'TEST-AI-REVIEW-GATE',
      severity: 'CRITICAL',
      title: 'AI review gate',
      why: 'corpus-level co-occurrence',
      fix: 'add a generatedByModel column somewhere',
      researchCitation: 'test',
      check: {
        kind: 'co-occurrence',
        globs: ['src/**/*.{ts,tsx,js,mjs}'],
        trigger: { patterns: ["from\\s+['\"]@anthropic-ai/sdk['\"]"] },
        required: { patterns: ['generatedByModel'] },
      },
    };

    // Trigger fires, no marker anywhere → fail.
    let results = await runRules([rule], root);
    assert.equal(results[0].passed, false, 'should fail when AI SDK imported but no marker present');

    // Add the marker in a different file (entity schema).
    await mkdir(join(root, 'src', 'lib'), { recursive: true });
    await writeFile(
      join(root, 'src', 'lib', 'schema.ts'),
      "export const Schema = { columns: { generatedByModel: { type: 'string' } } };\n",
    );
    results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should pass when marker exists somewhere in corpus');

    // Remove the trigger entirely → vacuous-pass.
    await rm(libFile);
    results = await runRules([rule], root);
    assert.equal(results[0].passed, true, 'should pass vacuously when no trigger fires');
    assert.equal(results[0].vacuous, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBaseIdOverrideCollision() {
  // Pre-refactor shape: per-product manifest re-uses base rule ids
  // (HIGH-SV-INTEGRITY-MD, CRIT-SV-NO-SILENT-PASS, etc.) to specialise
  // globs. CRIT-SV-NO-BASE-ID-OVERRIDE must report each collision.
  const root = await makeRepo();
  try {
    await writeFile(join(root, 'INTEGRITY.md'), '# integrity\n');
    await writeFile(
      join(root, 'audits', 'rules', 'architectural-rules.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          rules: [
            {
              id: 'HIGH-SV-INTEGRITY-MD',
              severity: 'HIGH',
              title: 'specialised',
              why: 'override attempt',
              fix: '-',
              researchCitation: 'test',
              check: { kind: 'file-exists-any', paths: ['INTEGRITY.md'] },
            },
            {
              id: 'CRIT-SV-NO-SILENT-PASS',
              severity: 'CRITICAL',
              title: 'specialised',
              why: 'override attempt',
              fix: '-',
              researchCitation: 'test',
              check: { kind: 'forbidden-regex', globs: ['src/**/*.ts'], patterns: ['catch'] },
            },
            {
              id: 'HIGH-PROD-EXTENSION',
              severity: 'HIGH',
              title: 'genuine extension, no collision',
              why: 'extends base with product-specific id',
              fix: '-',
              researchCitation: 'test',
              check: { kind: 'file-exists-any', paths: ['nonexistent.txt'] },
            },
          ],
        },
        null,
        2,
      ),
    );

    const { collisions, effective } = await buildEffectiveRules({ repoRoot: root });
    const collisionIds = collisions.map((c) => c.ruleId).sort();
    assert.deepEqual(
      collisionIds,
      ['CRIT-SV-NO-SILENT-PASS', 'HIGH-SV-INTEGRITY-MD'],
      'two base-id collisions should be detected',
    );

    const effectiveIds = effective.map((r) => r.id);
    assert.ok(
      effectiveIds.includes('HIGH-PROD-EXTENSION'),
      'product-specific id (no collision) should remain in effective rules',
    );

    // The colliding per-product rules should NOT replace the base rules.
    // The base rules' check should still be the base check, not the
    // per-product specialisation.
    const baseIntegrityMd = effective.find((r) => r.id === 'HIGH-SV-INTEGRITY-MD');
    assert.equal(
      baseIntegrityMd?.title,
      'Startvest Integrity Framework — INTEGRITY.md must exist at repo root',
      'base rule must not be overridden by colliding per-product rule',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBaseIdOverridePostRefactor() {
  // Post-refactor shape: per-product manifest uses product-specific ids
  // (HIGH-FL-*, CRIT-FL-*). No collisions; both base and per-product
  // rules sit in effective[].
  const root = await makeRepo();
  try {
    await writeFile(join(root, 'INTEGRITY.md'), '# integrity\n');
    await writeFile(
      join(root, 'audits', 'rules', 'architectural-rules.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          rules: [
            {
              id: 'HIGH-FL-INTEGRITY-MD',
              severity: 'HIGH',
              title: 'FieldLedger-specific INTEGRITY.md check',
              why: 'product-specific id, no collision',
              fix: '-',
              researchCitation: 'test',
              check: { kind: 'file-exists-any', paths: ['INTEGRITY.md'] },
            },
            {
              id: 'CRIT-FL-NO-SILENT-PASS',
              severity: 'CRITICAL',
              title: 'FieldLedger-specific silent-pass scan',
              why: 'product-specific id, no collision',
              fix: '-',
              researchCitation: 'test',
              check: {
                kind: 'forbidden-regex',
                globs: ['src/lib/indirect-rate-engine.ts'],
                patterns: ['catch\\s*\\([^)]*\\)\\s*\\{[^}]{0,400}verified\\s*:\\s*true'],
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const { collisions, effective } = await buildEffectiveRules({ repoRoot: root });
    assert.deepEqual(collisions, [], 'post-refactor manifest should have zero collisions');

    const effectiveIds = effective.map((r) => r.id);
    assert.ok(effectiveIds.includes('HIGH-SV-INTEGRITY-MD'), 'base rule still present');
    assert.ok(effectiveIds.includes('HIGH-FL-INTEGRITY-MD'), 'product rule layered on top');
    assert.ok(effectiveIds.includes('CRIT-SV-NO-SILENT-PASS'), 'base silent-pass still present');
    assert.ok(effectiveIds.includes('CRIT-FL-NO-SILENT-PASS'), 'product silent-pass layered on top');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tests = [
  ['file-exists-any', testFileExistsAny],
  ['forbidden-regex', testForbiddenRegex],
  ['required-regex (vacuous + matchAll)', testRequiredRegexVacuous],
  ['co-occurrence (trigger + required + vacuous)', testCoOccurrence],
  ['CRIT-SV-CUSTOMER-ATTESTATION-VALIDATION-GATE: ADA-shape', testCustomerAttestationValidationGate],
  ['integrity-md-claims: catches CL-style drift', testIntegrityMdClaimsCatchesClarityLiftDrift],
  ['integrity-md-claims: passes after fix', testIntegrityMdClaimsPassesAfterFix],
  ['integrity-md-claims: structural lint + strikethrough', testIntegrityMdClaimsStructuralLint],
  ['integrity-md-claims: catches Outstanding Risks reverse drift', testIntegrityMdClaimsCatchesReverseDrift],
  ['integrity-md-claims: absence claim verified', testIntegrityMdClaimsAbsenceClaimVerified],
  ['manifest merge + verify', testManifestMerge],
  ['CRIT-SV-NO-BASE-ID-OVERRIDE: pre-refactor manifest collisions', testBaseIdOverrideCollision],
  ['CRIT-SV-NO-BASE-ID-OVERRIDE: post-refactor manifest passes', testBaseIdOverridePostRefactor],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  FAIL  ${name}\n    ${err.stack ?? err.message}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nAll ${tests.length} tests passed\n`);
