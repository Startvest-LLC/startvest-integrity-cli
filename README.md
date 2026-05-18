# @startvest/integrity-cli

The reference CLI for [The Integrity Framework](https://theintegrityframework.org/framework/v1) — a public CC BY 4.0 trust standard for sub-enterprise AI tools, where SOC 2 audits don't apply.

Three surfaces:

1. **`integrity check`** — Run the v1.0 assertion suite against any repo. Deterministic runner, no LLM, no network.
2. **`integrity directory`** — Browse and submit listings to the [Integrity Framework Directory](https://theintegrityframework.org/listings).
3. **`integrity badge`** — Emit tier-badge markdown for your README, linking back to the framework spec or your directory listing.

Zero runtime dependencies. Pure ESM. Node ≥ 20.

## Install

```bash
npx @startvest/integrity-cli check ./your-repo
```

Or globally:

```bash
npm install -g @startvest/integrity-cli
integrity check ./your-repo
```

## Usage

```bash
integrity check <repo>                        # run base + per-product manifest
integrity verify <repo>                       # confirm repo manifest covers base rule ids
integrity rules                               # print the v1.0 base manifest as JSON
integrity directory list                      # browse listings on theintegrityframework.org
integrity directory show <slug>               # full detail for one listing
integrity directory validate <file>           # check a listing JSON against the schema
integrity directory submit <file>             # validate then surface the submission paths
integrity badge <bronze|silver> [--slug=...]  # emit tier-badge markdown
integrity --version
```

## Directory subcommand

Reads `https://theintegrityframework.org/api/listings.json` for `list` and `show`. Writes nothing — `submit` validates the file locally and prints the two
submission paths (GitHub PR or email to `integrity@startvest.ai`).

The validation schema mirrors the directory's zod schema in
`Startvest-LLC/theintegrityframework:src/lib/listings.ts`. If the schema drifts,
update both sides.

### Flags (check)

- `--format=human|json` — human is default. JSON is CI-consumable.
- `--strict` — exit non-zero on HIGH failures too. Default: only CRITICAL fails.
- `--base-only` — skip per-product manifests, run base only.
- `--no-base` — skip base, run per-product only.

### Exit codes

- `0` — all required rules passed
- `1` — one or more CRITICAL findings
- `2` — one or more HIGH findings (only when `--strict`)
- `3` — usage error

## Badge

Once your product is listed in the directory at a Bronze or Silver tier, you can embed a tier badge in your README so prospective buyers can verify the listing in one click.

```bash
$ integrity badge bronze --slug=mycompany
[![Integrity Framework Bronze](https://img.shields.io/badge/INTEGRITY-Bronze-CD7F32?logoColor=white)](https://theintegrityframework.org/listings/mycompany)
```

Output formats:

- `--format=markdown` (default) — the markdown shown above
- `--format=html` — `<a><img></a>` for trust pages
- `--format=url` — image URL only, for places that ask for the bare badge URL
- `--format=json` — all fields, for tooling

Without `--slug`, the badge links to `/framework/v1` instead of a listing page — useful for projects that follow the framework but haven't submitted a listing yet.

Gold is deferred to a future framework version; only `bronze` and `silver` are accepted today.

## How it works

The CLI ships a base manifest at `manifests/base-v1.json` containing the
universal Layer-2 assertions every Startvest product must satisfy:

- `CRIT-SV-NO-BASE-ID-OVERRIDE` — per-product manifests must not re-use base
  rule ids (drift prevention; enforced at manifest-merge time).
- `CRIT-SV-AI-REVIEW-GATE` — repos that invoke an LLM (any AI SDK import or
  `messages.create` / `chat.completions.create` call) must record a
  review-gate marker (`generatedByModel`, `reviewedBy`, etc.) somewhere in
  the corpus (co-occurrence; revised v1.3.0 to fix false negatives in
  layered architectures).
- `HIGH-SV-INTEGRITY-MD` — repo has an `INTEGRITY.md` at root.
- `CRIT-SV-NO-SILENT-PASS` — no `verified: true` / `compliant: true` /
  `status: 'passed'` returned from a `catch` block.
- `HIGH-SV-METHODOLOGY-VERSIONED` — public methodology pages carry version +
  changelog (markdown or TSX `<Section title="Version">` rendering both
  satisfy; vacuous-pass until the page exists).
- `HIGH-SV-EVIDENCE-RETENTION` — offboarding/DSAR code does not delete audit
  / consent / evidence tables.
- `CRIT-SV-NO-PRE-POPULATED-ATTESTATION` — attestation-generating code paths
  reference customer-submitted markers (Delve-lesson rule, v1.1).
- `INFO-SV-TRUST-PRINCIPLES-LINK` — privacy or marketing surface links to
  `startvest.ai/trust-principles`.

It then merges in any per-product rules found at
`<repo>/audits/rules/*.json` (ClarityLift's schema, since adopted across the
Startvest portfolio). Per-product rules **extend** the base with new,
product-specific ids (e.g. `HIGH-FL-EVIDENCE-RETENTION` for FieldLedger,
`CRIT-CL-*` for ClarityLift). Per-product rules **must not** re-use a base
rule id — `CRIT-SV-NO-BASE-ID-OVERRIDE` (base v1.2.0+) detects collisions
at manifest-merge time and the colliding per-product rule is dropped. Both
the base rule and the product-specific rule run; coverage layers, never
overrides. This closes the silent-loosening drift vector.

## Manifest schema

Each rule is:

```jsonc
{
  "id": "SEV-DOMAIN-NNN",
  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
  "title": "one-line summary",
  "why": "the reason this rule exists",
  "fix": "remediation hint",
  "researchCitation": "pointer back to docs / framework",
  "check": {
    "kind": "forbidden-regex" | "required-regex" | "file-exists-any",
    "globs": ["src/**/*.ts"],
    "patterns": ["regex strings"],
    "paths": ["literal paths for file-exists-any"],
    "matchAll": true,
    "matchAny": true,
    "skipFiles": ["glob patterns to exclude"]
  }
}
```

## False-positive handling

Per-rule file exclusions go in `.auditignore` at the repo root, format:

```
RULE_ID  path/glob  # reason
```

Lines starting with `#` are comments. The runner merges `.auditignore`
entries with any in-rule `skipFiles` list.

## CI integration

```yaml
# .github/workflows/integrity.yml
name: integrity
on: [pull_request, push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx @startvest/integrity-cli check . --strict
```

## Versioning

The base manifest is versioned independently of the CLI. Rule additions go in
minor versions; rule removals or shape changes go in major versions. The
running version is reported in every check output.

## License

MIT — see [LICENSE](./LICENSE). The framework specification itself (Layer 1 vetoes, Layer 2 constraints, Layer 3 guardrails) is published separately under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) at [theintegrityframework.org/framework/v1](https://theintegrityframework.org/framework/v1).
