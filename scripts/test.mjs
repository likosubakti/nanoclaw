#!/usr/bin/env node
/**
 * Test runner.
 *
 * Node cannot import TypeScript with path aliases directly, so each *.test.ts
 * is bundled with esbuild into a temporary directory and handed to Node's
 * built-in test runner. Keeping the toolchain to esbuild + node:test avoids a
 * second test framework in the dependency tree.
 */
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(os.tmpdir(), 'glm-studio-test-'));

const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(root, 'src/shared', args.path.slice('@shared/'.length) + '.ts'),
    }));
  },
};

async function findTests(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(full)));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const tests = await findTests(path.join(root, 'src'));
if (tests.length === 0) {
  console.log('[test] no test files found');
  process.exit(0);
}

await esbuild.build({
  entryPoints: tests,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'inline',
  // Electron is unavailable outside the app; tests cover the modules that do
  // not need it, so importing it should fail loudly rather than silently pass.
  external: ['electron'],
  plugins: [aliasPlugin],
  logLevel: 'warning',
});

// esbuild emits .js, which Node reads as CommonJS unless the nearest
// package.json says otherwise.
writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));

// Pass the built files explicitly: pointing --test at a bare directory relies
// on Node's test-file discovery rules, which differ across versions.
const built = (await findBuilt(outDir)).sort();
console.log(`[test] running ${built.length} test file(s)`);

const result = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
rmSync(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);

async function findBuilt(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findBuilt(full)));
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found;
}
