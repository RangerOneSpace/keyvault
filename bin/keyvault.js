#!/usr/bin/env node
import readline from 'node:readline';
import { main } from '../src/cli.js';
import { IS_SEA } from '../src/util.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`KeyVault needs Node.js 20 or newer. You have ${process.versions.node}. Get it from https://nodejs.org`);
  process.exit(1);
}

main(process.argv.slice(2)).catch(err => {
  console.error(`\nKeyVault could not start: ${err?.message || err}`);
  if (IS_SEA) {
    // Keep a double-clicked window open long enough to read the error.
    console.error('\nPress Enter to close this window.');
    readline.createInterface({ input: process.stdin }).once('line', () => process.exit(1));
    return;
  }
  process.exit(1);
});
