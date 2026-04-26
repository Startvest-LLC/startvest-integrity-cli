// Human reporter — green/red table + per-failure detail. ANSI colour by
// default; suppressed when stdout is not a TTY or NO_COLOR is set.

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function useColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

function paint(stream) {
  const on = useColor(stream);
  const wrap = (open) => (s) => (on ? `\x1b[${open}m${s}\x1b[0m` : s);
  return {
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    dim: wrap('2'),
    bold: wrap('1'),
    cyan: wrap('36'),
  };
}

function pad(s, n) {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

export function renderHuman({ results, repoRoot, baseVersion, sources, stream = process.stdout }) {
  const c = paint(stream);
  const lines = [];

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const r of failed) counts[r.severity] = (counts[r.severity] ?? 0) + 1;

  lines.push(c.bold(`Startvest Integrity Framework v${baseVersion}`));
  lines.push(c.dim(`Repo: ${repoRoot}`));
  lines.push(c.dim(`Sources: ${sources.length} manifest file(s)`));
  lines.push('');

  const idWidth = Math.max(8, ...results.map((r) => r.ruleId.length));
  const sevWidth = 8;

  for (const r of results) {
    let status;
    if (!r.passed) status = c.red('FAIL');
    else if (r.vacuous) status = c.yellow('VAC ');
    else if (r.skipped) status = c.dim('SKIP');
    else status = c.green('PASS');
    const sev = r.passed ? c.dim(pad(r.severity, sevWidth)) : c.yellow(pad(r.severity, sevWidth));
    const suffix = r.vacuous ? c.dim(`  (vacuous: ${r.vacuousReason})`) : '';
    lines.push(`  ${status}  ${sev}  ${pad(r.ruleId, idWidth)}  ${c.dim(r.title)}${suffix}`);
  }

  const vacuousCount = results.filter((r) => r.vacuous).length;
  const skippedCount = results.filter((r) => r.skipped).length;

  lines.push('');
  const total = results.length;
  const passedCount = passed.length;
  const summaryColor = failed.length === 0 ? c.green : counts.CRITICAL > 0 ? c.red : c.yellow;
  lines.push(summaryColor(c.bold(`${passedCount}/${total} passed`)));
  if (vacuousCount > 0) {
    lines.push(
      c.yellow(
        `${vacuousCount} of those passed vacuously (no candidate files matched globs — override per-product if you have a non-standard layout)`,
      ),
    );
  }
  if (skippedCount > 0) {
    lines.push(c.dim(`${skippedCount} rule(s) skipped (non-architectural — marketing/content)`));
  }
  if (failed.length > 0) {
    const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
      (s) => `${counts[s]} ${s.toLowerCase()}`,
    );
    lines.push(c.dim(`Failures by severity: ${parts.join(', ')}`));
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push(c.bold('Failures:'));
    for (const sev of SEVERITY_ORDER) {
      const bucket = failed.filter((r) => r.severity === sev);
      if (bucket.length === 0) continue;
      lines.push('');
      lines.push(c.yellow(`  [${sev}]`));
      for (const r of bucket) {
        lines.push(`  ${c.bold(r.ruleId)}  ${r.title}`);
        for (const f of r.findings) {
          lines.push(`    ${c.dim('at')} ${f.location}`);
          if (f.found) lines.push(`    ${c.dim('found:')} ${f.found}`);
        }
        if (r.findings[0]) {
          lines.push(`    ${c.dim('why:')} ${r.findings[0].why}`);
          lines.push(`    ${c.dim('fix:')} ${r.findings[0].fix}`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
