// Badge subcommand. Generates markdown / HTML / URL for an INTEGRITY
// framework tier badge that links back to the canonical framework spec or
// to a specific listing on the directory.
//
// Usage:
//   integrity badge bronze
//   integrity badge silver --slug=mycompany
//   integrity badge bronze --slug=mycompany --format=html
//   integrity badge bronze --format=url
//
// Image source: shields.io static badges. Tiers use canonical metal colors.

const VALID_TIERS = new Set(['bronze', 'silver']);
const TIER_COLOR = {
  bronze: 'CD7F32',
  silver: 'C0C0C0',
};
const FRAMEWORK_URL = 'https://theintegrityframework.org/framework/v1';
const DIRECTORY_BASE = 'https://theintegrityframework.org/listings';

export function buildBadge({ tier, slug }) {
  const t = String(tier || '').toLowerCase();
  if (!VALID_TIERS.has(t)) {
    throw new Error(
      `unknown tier "${tier}"; expected one of: ${Array.from(VALID_TIERS).join(', ')}`,
    );
  }
  const label = t.charAt(0).toUpperCase() + t.slice(1);
  const color = TIER_COLOR[t];
  const imageUrl = `https://img.shields.io/badge/INTEGRITY-${label}-${color}?logoColor=white`;
  const linkUrl = slug ? `${DIRECTORY_BASE}/${encodeURIComponent(slug)}` : FRAMEWORK_URL;
  const alt = `Integrity Framework ${label}`;
  return { tier: t, label, color, imageUrl, linkUrl, alt, slug: slug || null };
}

export function badgeMarkdown(b) {
  return `[![${b.alt}](${b.imageUrl})](${b.linkUrl})`;
}

export function badgeHtml(b) {
  return `<a href="${b.linkUrl}"><img src="${b.imageUrl}" alt="${b.alt}"></a>`;
}

export async function runBadge(argv) {
  let tier = null;
  let slug = null;
  let format = 'markdown';
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (a.startsWith('--slug=')) slug = a.slice('--slug='.length);
    else if (a.startsWith('--format=')) format = a.slice('--format='.length);
    else if (!a.startsWith('--')) tier = a;
  }
  if (!tier) {
    process.stderr.write(`integrity badge: <tier> is required\n${usage()}\n`);
    return 3;
  }
  let b;
  try {
    b = buildBadge({ tier, slug });
  } catch (e) {
    process.stderr.write(`integrity badge: ${e.message}\n`);
    return 3;
  }
  if (format === 'markdown') process.stdout.write(`${badgeMarkdown(b)}\n`);
  else if (format === 'html') process.stdout.write(`${badgeHtml(b)}\n`);
  else if (format === 'url') process.stdout.write(`${b.imageUrl}\n`);
  else if (format === 'json') process.stdout.write(`${JSON.stringify(b, null, 2)}\n`);
  else {
    process.stderr.write(
      `integrity badge: unknown --format "${format}" (expected markdown, html, url, json)\n`,
    );
    return 3;
  }
  return 0;
}

function usage() {
  return [
    'Usage:',
    '  integrity badge <tier> [--slug=<slug>] [--format=markdown|html|url|json]',
    '',
    '  <tier>          bronze | silver (Gold deferred to a future framework version)',
    '  --slug=<slug>   Directory listing slug. Without this, the badge links to',
    '                  /framework/v1 instead of /listings/<slug>.',
    '  --format=...    markdown (default), html, url (image only), json (all fields)',
    '',
    'Examples:',
    '  integrity badge bronze',
    '  integrity badge silver --slug=mycompany',
    '  integrity badge bronze --format=html',
  ].join('\n');
}
