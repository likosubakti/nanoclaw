#!/usr/bin/env node
/**
 * Launches the built app, waits for the renderer to report that its shell
 * mounted, and exits non-zero if it does not. Catches the class of failure a
 * typecheck cannot: a bad preload path, a broken CSP, a crash during boot.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: electronPath } = await import('electron');

const TIMEOUT_MS = 60_000;

const child = spawn(electronPath, ['.', '--no-sandbox'], {
  cwd: root,
  env: { ...process.env, GLM_STUDIO_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;

function finish(code, message) {
  if (settled) return;
  settled = true;
  console.log(message);
  if (code !== 0) console.log('--- output ---\n' + output);
  child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
    if (chunk.includes('SMOKE_OK')) finish(0, '[smoke] renderer mounted');
    if (chunk.includes('SMOKE_FAIL')) finish(1, '[smoke] renderer failed to start');
  });
}

child.on('error', (err) => finish(1, `[smoke] could not launch: ${err.message}`));
child.on('exit', (code) => finish(code === 0 ? 0 : 1, `[smoke] exited early with code ${code}`));

setTimeout(() => finish(1, `[smoke] timed out after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
