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

const tests = [
  ['file-exists-any', testFileExistsAny],
  ['forbidden-regex', testForbiddenRegex],
  ['required-regex (vacuous + matchAll)', testRequiredRegexVacuous],
  ['manifest merge + verify', testManifestMerge],
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
