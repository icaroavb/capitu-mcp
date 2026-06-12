#!/usr/bin/env node
/**
 * Native-module health check (runs on postinstall, and standalone).
 *
 * The whole capitu stack depends on better-sqlite3, a *native* module compiled
 * for one specific Node ABI (NODE_MODULE_VERSION). If the module on disk was
 * built for a different ABI than the Node that loads it, every server crashes
 * at boot with "compiled against a different Node.js version". This is THE
 * recurring failure on machines that have more than one Node (e.g. an nvm Node
 * shadowing the one your MCP client launches with).
 *
 * This script tries to load better-sqlite3 under the *current* Node and, on
 * mismatch, prints exactly what's wrong and how to fix it — instead of letting
 * the cryptic error surface only later inside the MCP client's logs.
 *
 * It NEVER fails the install (exit 0 always): a fresh clone may legitimately
 * postinstall under a different Node than the client, and we don't want to
 * break `npm install`. It's a loud diagnostic, not a gate.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const abi = process.versions.modules;
const ver = process.version;

function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE _probe(x)');
  db.close();
  ok(`better-sqlite3 loads under Node ${ver} (ABI ${abi}). Native modules OK.`);
  process.exit(0);
} catch (err) {
  const msg = String(err && err.message ? err.message : err);
  const mismatch = /NODE_MODULE_VERSION|different Node\.js version/i.test(msg);

  console.log('');
  warn(`better-sqlite3 did NOT load under Node ${ver} (ABI ${abi}).`);
  console.log('');

  if (mismatch) {
    // Pull the "compiled against ABI X / requires ABI Y" numbers if present.
    const compiled = msg.match(/NODE_MODULE_VERSION (\d+)/);
    const requires = msg.match(/requires NODE_MODULE_VERSION (\d+)/);
    if (compiled && requires) {
      console.log(
        `  The binary was compiled for ABI ${compiled[1]} but this Node needs ABI ${requires[1]}.`,
      );
    }
    console.log('');
    console.log('  This is the classic multi-Node mismatch. The native module must be');
    console.log('  built with the SAME Node that your MCP client (Claude Desktop / Claude');
    console.log('  Code) uses to launch the servers — usually the one in:');
    console.log('');
    console.log('      C:\\Program Files\\nodejs   (Windows)');
    console.log('');
    console.log('  Fix: run the install with THAT Node on PATH, e.g. in PowerShell:');
    console.log('');
    console.log('      $env:Path = "C:\\Program Files\\nodejs;$env:Path"');
    console.log('      npm run rebuild:native');
    console.log('');
    console.log('  (A bare `npm install` from a shell whose default Node differs — e.g. an');
    console.log('  nvm Node — will rebuild for the WRONG ABI and reintroduce this crash.)');
  } else {
    console.log('  Unexpected load error (not an ABI mismatch):');
    console.log(`      ${msg}`);
    console.log('');
    console.log('  Try: npm run rebuild:native');
  }
  console.log('');
  // Diagnostic only — never break the install.
  process.exit(0);
}
