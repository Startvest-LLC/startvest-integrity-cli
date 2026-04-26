// Directory subcommand. Read-only browse + submit-via-PR/email for the
// Integrity Framework Directory at https://theintegrityframework.org.
//
// Subcommands:
//   directory list [--tier=bronze|silver] [--format=human|json]
//   directory show <slug> [--format=human|json]
//   directory validate <file>
//   directory submit <file>
//
// No external deps. Validation is hand-rolled to mirror the directory's
// zod schema (src/lib/listings.ts in the directory repo). If the schema
// drifts, update both sides.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIRECTORY_URL = 'https://theintegrityframework.org';
const LISTINGS_ENDPOINT = `${DIRECTORY_URL}/api/listings.json`;
const SUBMIT_EMAIL = 'integrity@startvest.ai';
const REPO_OWNER = 'Startvest-LLC';
const REPO_NAME = 'theintegrityframework';
const REPO_FILE_PATH = 'data/listings.json';

const TIERS = new Set(['bronze', 'silver']);
const LICENSES = new Set(['open-source', 'closed-source', 'mixed']);
const STATES = new Set(['active', 'downgraded', 'delisted']);

export async function runDirectory(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (sub === 'list') return cmdList(rest);
  if (sub === 'show') return cmdShow(rest);
  if (sub === 'validate') return cmdValidate(rest);
  if (sub === 'submit') return cmdSubmit(rest);

  process.stderr.write(`integrity directory: unknown subcommand "${sub}"\n${usage()}\n`);
  return 3;
}

function usage() {
  return [
    'Usage:',
    '  integrity directory list [--tier=bronze|silver] [--format=human|json]',
    '  integrity directory show <slug> [--format=human|json]',
    '  integrity directory validate <file>',
    '  integrity directory submit <file>',
    '',
    `Browse and submit listings for the Integrity Framework Directory at ${DIRECTORY_URL}.`,
    '',
    'Exit codes:',
    '  0  ok',
    '  1  validation failed / listing not found',
    '  2  network error',
    '  3  usage error',
  ].join('\n');
}

async function fetchListings() {
  let res;
  try {
    res = await fetch(LISTINGS_ENDPOINT, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    process.stderr.write(`integrity directory: network error reaching ${LISTINGS_ENDPOINT}: ${err.message}\n`);
    return null;
  }
  if (!res.ok) {
    process.stderr.write(`integrity directory: ${LISTINGS_ENDPOINT} returned HTTP ${res.status}\n`);
    return null;
  }
  return res.json();
}

function parseListFlags(argv) {
  const out = { tier: null, format: 'human' };
  for (const a of argv) {
    if (a.startsWith('--tier=')) out.tier = a.slice('--tier='.length);
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a === '--json') out.format = 'json';
    else if (a === '--human') out.format = 'human';
  }
  return out;
}

async function cmdList(argv) {
  const flags = parseListFlags(argv);
  if (flags.tier && !TIERS.has(flags.tier)) {
    process.stderr.write(`integrity directory list: --tier must be one of: ${[...TIERS].join(', ')}\n`);
    return 3;
  }

  const data = await fetchListings();
  if (!data) return 2;

  const listings = (data.listings ?? []).filter((l) => !flags.tier || l.tier === flags.tier);

  if (flags.format === 'json') {
    process.stdout.write(`${JSON.stringify({ ...data, listings }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`The Integrity Framework Directory v${data.version}\n`);
  process.stdout.write(`Last updated: ${data.lastUpdated}\n`);
  process.stdout.write(`Active: ${data.activeCount}, delisted: ${data.delistedCount}\n`);
  if (flags.tier) process.stdout.write(`Filtered to tier=${flags.tier}\n`);
  process.stdout.write('\n');

  if (listings.length === 0) {
    process.stdout.write('No listings match.\n');
    return 0;
  }

  for (const l of listings) {
    const star = l.operator?.isDirectoryOperator ? ' *' : '';
    process.stdout.write(`${pad(l.tier.toUpperCase(), 8)}${pad(l.slug, 32)}${l.name}${star}\n`);
  }
  process.stdout.write('\n');
  if (listings.some((l) => l.operator?.isDirectoryOperator)) {
    process.stdout.write('* operated by the directory operator (Startvest LLC). See methodology #operator-coi.\n');
  }
  return 0;
}

async function cmdShow(argv) {
  const slug = argv[0];
  const flags = parseListFlags(argv.slice(1));
  if (!slug) {
    process.stderr.write('integrity directory show: <slug> is required\n');
    return 3;
  }

  const data = await fetchListings();
  if (!data) return 2;

  const l = (data.listings ?? []).find((x) => x.slug === slug);
  if (!l) {
    process.stderr.write(`integrity directory show: no listing with slug "${slug}"\n`);
    return 1;
  }

  if (flags.format === 'json') {
    process.stdout.write(`${JSON.stringify(l, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${l.name}${l.operator?.isDirectoryOperator ? ' *' : ''}\n`);
  process.stdout.write(`${'─'.repeat(60)}\n`);
  process.stdout.write(`Tier:           ${l.tier}\n`);
  if (l.category) process.stdout.write(`Category:       ${l.category}\n`);
  process.stdout.write(`Operator:       ${l.operator.name}\n`);
  process.stdout.write(`License:        ${l.license}\n`);
  process.stdout.write(`First listed:   ${l.firstListedDate}\n`);
  process.stdout.write(`Last rescanned: ${l.lastRescannedDate}\n`);
  process.stdout.write(`State:          ${l.state}${l.stateNote ? ` (${l.stateNote})` : ''}\n`);
  process.stdout.write('\n');
  process.stdout.write(`${l.description}\n\n`);
  process.stdout.write(`Homepage:       ${l.homepageUrl}\n`);
  process.stdout.write(`INTEGRITY.md:   ${l.integrityMdUrl}\n`);
  if (l.silverCredential) {
    if (l.silverCredential.kind === 'methodology-page') {
      process.stdout.write(`Methodology:    ${l.silverCredential.url}\n`);
    } else if (l.silverCredential.kind === 'integrity-cli') {
      process.stdout.write(`integrity-cli:  ${l.silverCredential.outputUrl}`);
      if (l.silverCredential.commitSha) process.stdout.write(` @ ${l.silverCredential.commitSha}`);
      process.stdout.write('\n');
    }
  }
  if (l.rationale) {
    process.stdout.write('\n');
    process.stdout.write(`${l.rationale}\n`);
  }
  if (l.operator?.isDirectoryOperator) {
    process.stdout.write('\n');
    process.stdout.write(`* Operated by the directory operator. See ${DIRECTORY_URL}/methodology#operator-coi for COI handling.\n`);
  }
  return 0;
}

async function cmdValidate(argv) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('integrity directory validate: <file> is required\n');
    return 3;
  }

  let raw;
  try {
    raw = await readFile(resolve(file), 'utf8');
  } catch (err) {
    process.stderr.write(`integrity directory validate: cannot read ${file}: ${err.message}\n`);
    return 1;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`integrity directory validate: ${file} is not valid JSON: ${err.message}\n`);
    return 1;
  }

  const errors = validateListing(parsed);
  if (errors.length > 0) {
    process.stderr.write(`integrity directory validate: ${errors.length} error${errors.length > 1 ? 's' : ''} in ${file}\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }

  process.stdout.write(`OK: ${file} is a valid listing for tier=${parsed.tier}.\n`);
  if (parsed.tier === 'silver' && parsed.silverCredential?.kind === 'methodology-page') {
    process.stdout.write(`Reminder: the directory operator will fetch ${parsed.silverCredential.url} during review and verify it has Version + Changelog headings.\n`);
  } else if (parsed.tier === 'silver' && parsed.silverCredential?.kind === 'integrity-cli') {
    process.stdout.write(`Reminder: the directory operator will fetch ${parsed.silverCredential.outputUrl} during review and verify the runner output passes.\n`);
  }
  return 0;
}

async function cmdSubmit(argv) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('integrity directory submit: <file> is required\n');
    return 3;
  }

  let raw;
  try {
    raw = await readFile(resolve(file), 'utf8');
  } catch (err) {
    process.stderr.write(`integrity directory submit: cannot read ${file}: ${err.message}\n`);
    return 1;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`integrity directory submit: ${file} is not valid JSON: ${err.message}\n`);
    return 1;
  }

  const errors = validateListing(parsed);
  if (errors.length > 0) {
    process.stderr.write(`integrity directory submit: validation failed (${errors.length} error${errors.length > 1 ? 's' : ''})\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write('\nFix the listing and re-run. Use "integrity directory validate" to check before submitting.\n');
    return 1;
  }

  const editUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/edit/master/${REPO_FILE_PATH}`;
  const compareUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/compare/master...master?quick_pull=1&title=${encodeURIComponent(`Add listing: ${parsed.name}`)}&body=${encodeURIComponent(`Adds the listing for **${parsed.name}** at tier ${parsed.tier}.`)}`;
  const mailtoBody =
    `Submission for the Integrity Framework Directory.\n\n` +
    `Listing JSON to add to data/listings.json (after the existing entries):\n\n` +
    `${JSON.stringify(parsed, null, 2)}\n`;
  const mailtoUrl = `mailto:${SUBMIT_EMAIL}?subject=${encodeURIComponent(`Directory submission: ${parsed.name}`)}&body=${encodeURIComponent(mailtoBody)}`;

  process.stdout.write(`Listing for "${parsed.name}" (tier=${parsed.tier}) is valid.\n\n`);
  process.stdout.write('Two submission paths. Pick one:\n\n');

  process.stdout.write('Path 1: GitHub pull request\n');
  process.stdout.write(`  1. Fork ${REPO_OWNER}/${REPO_NAME} on GitHub.\n`);
  process.stdout.write(`  2. Edit data/listings.json on your fork: add this object to the "listings" array.\n`);
  process.stdout.write(`     Quick edit URL (own fork required): ${editUrl}\n`);
  process.stdout.write(`  3. Open a PR against ${REPO_OWNER}/${REPO_NAME}:master.\n`);
  process.stdout.write(`     Compare page: ${compareUrl}\n\n`);

  process.stdout.write('Path 2: email\n');
  process.stdout.write(`  Send the JSON below to ${SUBMIT_EMAIL}.\n`);
  process.stdout.write(`  Pre-filled mailto: ${mailtoUrl.length > 200 ? '(too long for terminal; copy from below)' : mailtoUrl}\n\n`);

  process.stdout.write('--- Listing JSON ---\n');
  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  process.stdout.write('--- end ---\n\n');

  process.stdout.write('Review SLA: 14 calendar days from submission to first response.\n');
  return 0;
}

// --- validation -----------------------------------------------------------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

function validateListing(l) {
  const errors = [];
  if (!l || typeof l !== 'object' || Array.isArray(l)) {
    return ['listing must be a JSON object'];
  }

  must(errors, 'slug', typeof l.slug === 'string' && SLUG_RE.test(l.slug), 'must be a kebab-case string');
  must(errors, 'name', typeof l.name === 'string' && l.name.length > 0, 'must be a non-empty string');
  must(errors, 'description', typeof l.description === 'string' && l.description.length >= 10 && l.description.length <= 160, 'must be a string between 10 and 160 chars');

  must(errors, 'homepageUrl', isHttpsUrl(l.homepageUrl), 'must be an https URL');
  must(errors, 'integrityMdUrl', isHttpsUrl(l.integrityMdUrl), 'must be an https URL');

  must(errors, 'tier', TIERS.has(l.tier), `must be one of: ${[...TIERS].join(', ')}`);
  must(errors, 'license', LICENSES.has(l.license), `must be one of: ${[...LICENSES].join(', ')}`);

  if (l.category !== undefined) {
    must(errors, 'category', typeof l.category === 'string', 'must be a string when provided');
  }

  if (!l.operator || typeof l.operator !== 'object') {
    errors.push('operator: must be an object with at least { name }');
  } else {
    must(errors, 'operator.name', typeof l.operator.name === 'string' && l.operator.name.length > 0, 'must be a non-empty string');
    if (l.operator.url !== undefined) {
      must(errors, 'operator.url', isHttpsUrl(l.operator.url), 'must be an https URL when provided');
    }
    if (l.operator.isDirectoryOperator !== undefined) {
      must(errors, 'operator.isDirectoryOperator', typeof l.operator.isDirectoryOperator === 'boolean', 'must be a boolean when provided');
    }
  }

  must(errors, 'firstListedDate', typeof l.firstListedDate === 'string' && ISO_DATE_RE.test(l.firstListedDate), 'must be ISO date YYYY-MM-DD');
  must(errors, 'lastRescannedDate', typeof l.lastRescannedDate === 'string' && ISO_DATE_RE.test(l.lastRescannedDate), 'must be ISO date YYYY-MM-DD');

  must(errors, 'state', STATES.has(l.state), `must be one of: ${[...STATES].join(', ')}`);
  if (l.state === 'downgraded' || l.state === 'delisted') {
    must(errors, 'stateNote', typeof l.stateNote === 'string' && l.stateNote.length > 0, `required when state is "${l.state}"`);
  }

  if (l.tier === 'silver') {
    if (!l.silverCredential || typeof l.silverCredential !== 'object') {
      errors.push('silverCredential: required when tier === "silver"');
    } else {
      const k = l.silverCredential.kind;
      if (k === 'methodology-page') {
        must(errors, 'silverCredential.url', isHttpsUrl(l.silverCredential.url), 'must be an https URL');
      } else if (k === 'integrity-cli') {
        must(errors, 'silverCredential.outputUrl', isHttpsUrl(l.silverCredential.outputUrl), 'must be an https URL');
        if (l.silverCredential.commitSha !== undefined) {
          must(errors, 'silverCredential.commitSha', typeof l.silverCredential.commitSha === 'string' && SHA_RE.test(l.silverCredential.commitSha), 'must be a 7-40 char hex string when provided');
        }
      } else {
        errors.push('silverCredential.kind: must be "methodology-page" or "integrity-cli"');
      }
    }
  }

  if (l.rationale !== undefined) {
    must(errors, 'rationale', typeof l.rationale === 'string' && l.rationale.length <= 800, 'must be a string up to 800 chars when provided');
  }

  if (l.socialLinks !== undefined) {
    if (typeof l.socialLinks !== 'object' || Array.isArray(l.socialLinks)) {
      errors.push('socialLinks: must be an object when provided');
    } else {
      for (const key of ['linkedin', 'twitter', 'github']) {
        if (l.socialLinks[key] !== undefined) {
          must(errors, `socialLinks.${key}`, isHttpsUrl(l.socialLinks[key]), 'must be an https URL when provided');
        }
      }
    }
  }

  return errors;
}

function must(errors, field, ok, msg) {
  if (!ok) errors.push(`${field}: ${msg}`);
}

function isHttpsUrl(v) {
  if (typeof v !== 'string' || !v.startsWith('https://')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function pad(s, n) {
  if (s.length >= n) return `${s}  `;
  return s + ' '.repeat(n - s.length);
}
