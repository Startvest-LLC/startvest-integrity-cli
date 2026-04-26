#!/usr/bin/env node
import { run } from '../src/cli.mjs';

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`integrity: ${err?.stack ?? err}\n`);
    process.exit(2);
  },
);
