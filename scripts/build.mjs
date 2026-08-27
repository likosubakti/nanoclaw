#!/usr/bin/env node
/**
 * Bundles the three Electron entry points with esbuild.
 *
 *   src/main      -> dist/main/index.js      (node platform, electron external)
 *   src/preload   -> dist/preload/index.js   (node platform, CommonJS: sandboxed
 *                                             preload scripts cannot use ESM)
 *   src/renderer  -> dist/renderer/main.js   (browser platform, everything bundled)
 *
 * Pass --watch to rebuild on change (used by scripts/dev.mjs).
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const alias = { '@shared': path.join(root, 'src/shared') };

/** esbuild resolves bare "@shared/x" imports through this tiny plugin. */
const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(alias['@shared'], args.path.slice('@shared/'.length) + '.ts'),
    }));
  },
};

const shared = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  plugins: [aliasPlugin],
};

const configs = [
  {
    ...shared,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Electron and the optional native pty binding are resolved at runtime.
    external: ['electron', 'node-pty'],
    banner: {
      // Bundled ESM in the main process still needs CJS interop shims for
      // dependencies that call require() internally.
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __dirname_of } from 'node:path';",
        'const require = __createRequire(import.meta.url);',
        'const __filename = __fileURLToPath(import.meta.url);',
        'const __dirname = __dirname_of(__filename);',
      ].join('\n'),
    },
  },
  {
    ...shared,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.cjs'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [path.join(root, 'src/renderer/main.ts')],
    outfile: path.join(root, 'dist/renderer/main.js'),
    platform: 'browser',
    target: 'chrome128',
    format: 'esm',
    loader: { '.css': 'css', '.woff2': 'file', '.png': 'dataurl', '.svg': 'dataurl' },
  },
];

async function copyStatic() {
  await mkdir(path.join(root, 'dist/renderer'), { recursive: true });
  await cp(path.join(root, 'src/renderer/index.html'), path.join(root, 'dist/renderer/index.html'));
  await cp(path.join(root, 'src/renderer/styles.css'), path.join(root, 'dist/renderer/styles.css'));
  if (existsSync(path.join(root, 'resources/icons'))) {
    await cp(path.join(root, 'resources/icons'), path.join(root, 'dist/resources/icons'), {
      recursive: true,
    });
  }
  await cp(path.join(root, 'resources/icon.svg'), path.join(root, 'dist/resources/icon.svg'));
}

async function ensureIcons() {
  const iconDir = path.join(root, 'resources/icons');
  if (existsSync(path.join(iconDir, '512x512.png'))) return;
  const { generateIcons } = await import('./gen-icons.mjs');
  await generateIcons();
}

async function run() {
  // Wipe dist first: a renamed or deleted source file would otherwise leave a
  // stale bundle behind, and electron-builder would ship it.
  if (!watch) rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  await ensureIcons();
  await copyStatic();
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[build] watching for changes…');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    console.log(`[build] ${pkg.productName} ${pkg.version} built into dist/`);
  }
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
