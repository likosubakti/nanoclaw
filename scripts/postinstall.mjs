#!/usr/bin/env node
/**
 * node-pty is a native module and has to match Electron's ABI. Rebuilding it is
 * best-effort: the app degrades to a pipe-based terminal when the binding is
 * missing, so a failure here must not break `npm install`.
 */
import { spawnSync } from 'node:child_process';

if (process.env.GLM_STUDIO_SKIP_REBUILD === '1' || process.env.CI === 'true') {
  console.log('[postinstall] skipping native rebuild');
  process.exit(0);
}

const result = spawnSync('npx', ['--no-install', 'electron-builder', 'install-app-deps'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.warn(
    '[postinstall] could not rebuild node-pty for Electron.\n' +
      '              The embedded agent terminal will fall back to pipe mode.\n' +
      '              To fix: install build tools (build-essential, python3) and run\n' +
      '              npx electron-builder install-app-deps',
  );
}
