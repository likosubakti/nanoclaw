#!/usr/bin/env node
/**
 * Development runner: esbuild in watch mode plus an Electron process that is
 * restarted whenever the main or preload bundle changes.
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const builder = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--watch'], {
  stdio: 'inherit',
  cwd: root,
});

let electron = null;
let restarting = false;

async function startElectron() {
  const { default: electronPath } = await import('electron');
  electron = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, GLM_STUDIO_DEV: '1', ELECTRON_ENABLE_LOGGING: '1' },
  });
  electron.on('exit', (code) => {
    if (!restarting) {
      builder.kill();
      process.exit(code ?? 0);
    }
  });
}

async function restart() {
  if (restarting) return;
  restarting = true;
  if (electron) electron.kill();
  await delay(250);
  restarting = false;
  await startElectron();
}

// Give esbuild a moment to produce the first bundle before launching Electron.
await delay(1500);
await startElectron();

for (const dir of ['dist/main', 'dist/preload']) {
  watch(path.join(root, dir), { persistent: true }, () => {
    void restart();
  });
}

process.on('SIGINT', () => {
  builder.kill();
  electron?.kill();
  process.exit(0);
});
