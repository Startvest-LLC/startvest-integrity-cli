// Tests for the badge subcommand. Plain asserts, no test framework.

import assert from 'node:assert/strict';
import { buildBadge, badgeMarkdown, badgeHtml } from '../src/badge.mjs';

function testBronzeDefaultLinksToFramework() {
  const b = buildBadge({ tier: 'bronze' });
  assert.equal(b.tier, 'bronze');
  assert.equal(b.label, 'Bronze');
  assert.equal(b.linkUrl, 'https://theintegrityframework.org/framework/v1');
  assert.match(b.imageUrl, /^https:\/\/img\.shields\.io\/badge\/INTEGRITY-Bronze-CD7F32/);
}

function testSilverWithSlugLinksToListing() {
  const b = buildBadge({ tier: 'silver', slug: 'mycompany' });
  assert.equal(b.label, 'Silver');
  assert.equal(b.linkUrl, 'https://theintegrityframework.org/listings/mycompany');
  assert.match(b.imageUrl, /^https:\/\/img\.shields\.io\/badge\/INTEGRITY-Silver-C0C0C0/);
}

function testCaseInsensitiveTier() {
  const b = buildBadge({ tier: 'BRONZE' });
  assert.equal(b.tier, 'bronze');
  assert.equal(b.label, 'Bronze');
}

function testUnknownTierThrows() {
  assert.throws(() => buildBadge({ tier: 'gold' }), /unknown tier/);
  assert.throws(() => buildBadge({ tier: '' }), /unknown tier/);
}

function testSlugEncoded() {
  const b = buildBadge({ tier: 'bronze', slug: 'co/with spaces' });
  // encodeURIComponent — slash becomes %2F, space becomes %20
  assert.ok(b.linkUrl.includes('co%2Fwith%20spaces'));
}

function testMarkdownRender() {
  const b = buildBadge({ tier: 'bronze', slug: 'mycompany' });
  const md = badgeMarkdown(b);
  // Standard markdown image-in-link: [![alt](img)](link)
  assert.match(md, /^\[!\[Integrity Framework Bronze\]\(https:\/\/img\.shields\.io\/badge\/INTEGRITY-Bronze-CD7F32[^)]*\)\]\(https:\/\/theintegrityframework\.org\/listings\/mycompany\)$/);
}

function testHtmlRender() {
  const b = buildBadge({ tier: 'silver' });
  const html = badgeHtml(b);
  assert.match(html, /^<a href="https:\/\/theintegrityframework\.org\/framework\/v1"><img src="https:\/\/img\.shields\.io\/badge\/INTEGRITY-Silver-C0C0C0[^"]*" alt="Integrity Framework Silver"><\/a>$/);
}

const tests = [
  ['badge: bronze default links to framework', testBronzeDefaultLinksToFramework],
  ['badge: silver with slug links to listing', testSilverWithSlugLinksToListing],
  ['badge: tier is case-insensitive', testCaseInsensitiveTier],
  ['badge: unknown tier throws', testUnknownTierThrows],
  ['badge: slug is URL-encoded', testSlugEncoded],
  ['badge: markdown render shape', testMarkdownRender],
  ['badge: html render shape', testHtmlRender],
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
process.stdout.write(`\nAll ${tests.length} badge tests passed\n`);
