#!/usr/bin/env node
/**
 * Wiring checker.
 *
 * The app spans three processes joined only by string channel names and tagged
 * unions. TypeScript checks each side in isolation but cannot tell you that a
 * channel has a handler and no caller, that a preload method is exposed and
 * never used, or that an event variant is emitted and never rendered. Those
 * gaps compile perfectly and fail silently at runtime — a button that does
 * nothing, a stream that never appears.
 *
 * This walks the seams and fails the build when one is left dangling.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = await walk(path.join(root, 'src'));
const source = new Map();
for (const file of files) source.set(file, await readFile(file, 'utf8'));

const rel = (file) => path.relative(root, file);
const inDir = (file, dir) => rel(file).startsWith(`src/${dir}/`);
const textOf = (predicate) =>
  [...source.entries()].filter(([f]) => predicate(f)).map(([, t]) => t).join('\n');

// Tests exercise things directly and would mask a real orphan, so exclude them.
const notTest = (file) => !file.endsWith('.test.ts');
const MAIN = textOf((f) => inDir(f, 'main') && notTest(f));
const PRELOAD = textOf((f) => inDir(f, 'preload'));
const RENDERER = textOf((f) => inDir(f, 'renderer') && notTest(f));
const SHARED = textOf((f) => inDir(f, 'shared') && notTest(f));

const problems = [];
const note = (kind, detail) => problems.push(`${kind}: ${detail}`);

/* ------------------------------------------------------------- channels -- */

const ipcFile = source.get(path.join(root, 'src/shared/ipc.ts')) ?? '';
const channels = [...ipcFile.matchAll(/^\s{2}(\w+):\s*'([^']+)',/gm)].map((m) => ({
  name: m[1],
  value: m[2],
}));

if (channels.length === 0) note('FATAL', 'no channels parsed from src/shared/ipc.ts');

/** A channel is referenced either by its constant or by its literal value. */
const refers = (text, channel) =>
  text.includes(`IPC.${channel.name}`) || text.includes(`'${channel.value}'`);

for (const channel of channels) {
  const handled =
    new RegExp(`ipcMain\\.handle\\(\\s*(IPC\\.${channel.name}\\b|'${channel.value}')`).test(MAIN);
  const pushed = new RegExp(`send\\(\\s*(IPC\\.${channel.name}\\b|'${channel.value}')`).test(MAIN);

  if (!handled && !pushed) {
    note('DEAD CHANNEL', `${channel.name} ('${channel.value}') has no handler and is never sent`);
    continue;
  }
  if (!refers(PRELOAD, channel)) {
    note('UNREACHABLE', `${channel.name} is wired in main but absent from the preload bridge`);
  }
}

/* ------------------------------------------------- literal channel names -- */

// A handler registered with a raw string instead of the shared constant is a
// rename waiting to break silently.
for (const match of MAIN.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
  const value = match[1];
  if (!channels.some((c) => c.value === value)) {
    note('UNDECLARED CHANNEL', `main handles '${value}', which is not in shared/ipc.ts`);
  }
}
for (const match of PRELOAD.matchAll(/ipcRenderer\.(?:invoke|on)\(\s*'([^']+)'/g)) {
  const value = match[1];
  if (!channels.some((c) => c.value === value)) {
    note('UNDECLARED CHANNEL', `preload uses '${value}', which is not in shared/ipc.ts`);
  }
}

/* ------------------------------------------------------ preload methods -- */

// Every method the bridge exposes should have a caller; an exposed method with
// none is either a dead feature or a button someone forgot to wire.
const bridgeBody = PRELOAD.slice(
  PRELOAD.indexOf('const api = {'),
  PRELOAD.indexOf('contextBridge.exposeInMainWorld'),
);

for (const match of bridgeBody.matchAll(/^\s{4}(\w+):\s*\(/gm)) {
  const method = match[1];
  // `on*` subscriptions and generic verbs collide across groups, so require the
  // call form rather than a bare mention.
  if (!new RegExp(`\\.${method}\\(`).test(RENDERER)) {
    note('UNUSED BRIDGE METHOD', `${method}() is exposed to the renderer but never called`);
  }
}

/* -------------------------------------------------------- event variants -- */

/** Pulls the `type: 'x'` tags out of a discriminated union declaration. */
function unionTags(text, typeName) {
  const start = text.indexOf(`export type ${typeName} =`);
  if (start === -1) return [];
  const end = text.indexOf('\n\n', start);
  const body = text.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]);
}

const unions = [
  { name: 'StreamEvent', emit: MAIN, handle: RENDERER },
  { name: 'RoundtableEvent', emit: MAIN, handle: RENDERER },
  { name: 'TerminalEvent', emit: MAIN, handle: RENDERER },
];

for (const union of unions) {
  const tags = unionTags(SHARED, union.name);
  if (tags.length === 0) {
    note('FATAL', `could not parse the ${union.name} union`);
    continue;
  }
  for (const tag of tags) {
    // Emitted as `type: 'tag'` in main.
    if (!new RegExp(`type:\\s*'${tag}'`).test(union.emit)) {
      note('NEVER EMITTED', `${union.name}.${tag} is declared but main never sends it`);
    }
    // Handled as `case 'tag'` in the renderer.
    if (!new RegExp(`case\\s*'${tag}'`).test(union.handle)) {
      note('UNHANDLED EVENT', `${union.name}.${tag} is sent but the renderer ignores it`);
    }
  }
}

/* ------------------------------------------------------------- app views -- */

// Every view in the union must be mountable and reachable from the sidebar.
const stateText = source.get(path.join(root, 'src/renderer/state.ts')) ?? '';
const viewMatch = /export type View =\s*([^;]+);/.exec(stateText);
if (viewMatch) {
  const views = [...viewMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const mainText = source.get(path.join(root, 'src/renderer/main.ts')) ?? '';
  for (const view of views) {
    if (!new RegExp(`case\\s*'${view}':`).test(mainText)) {
      note('UNMOUNTABLE VIEW', `'${view}' is in the View union but mountView never renders it`);
    }
  }
}

/* --------------------------------------------------------- menu routing -- */

// A menu item that sends a route the renderer does not handle is a no-op.
const menuText = source.get(path.join(root, 'src/main/menu.ts')) ?? '';
const rendererMain = source.get(path.join(root, 'src/renderer/main.ts')) ?? '';
for (const match of menuText.matchAll(/send\('([^']+)'\)/g)) {
  const route = match[1];
  if (!new RegExp(`case\\s*'${route}':`).test(rendererMain)) {
    note('DEAD MENU ITEM', `the menu sends '${route}', which handleNavigate ignores`);
  }
}
// And argv routing must land somewhere too.
const indexText = source.get(path.join(root, 'src/main/index.ts')) ?? '';
for (const match of indexText.matchAll(/IPC\.navigate,\s*'([^']+)'/g)) {
  const route = match[1];
  if (!new RegExp(`case\\s*'${route}':`).test(rendererMain)) {
    note('DEAD ARGV ROUTE', `launching routes to '${route}', which handleNavigate ignores`);
  }
}

/* ----------------------------------------------------------- CSS classes -- */

// A class the renderer sets but no stylesheet defines renders unstyled.
const cssText = await readFile(path.join(root, 'src/renderer/styles.css'), 'utf8');
const xtermClasses = /^xterm/;
const used = new Set();
for (const match of RENDERER.matchAll(/class:\s*`([^`]*)`|class:\s*'([^']*)'/g)) {
  const raw = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
  for (const name of raw.split(/\s+/).filter(Boolean)) used.add(name);
}
for (const name of used) {
  if (xtermClasses.test(name)) continue;
  if (!cssText.includes(`.${name}`)) {
    note('UNSTYLED CLASS', `the renderer applies .${name}, which styles.css never defines`);
  }
}

/* ---------------------------------------------------------------- report -- */

console.log(`[wiring] ${channels.length} channels, ${unions.length} event unions checked`);

if (problems.length === 0) {
  console.log('[wiring] every seam is connected');
  process.exit(0);
}

console.error(`\n[wiring] ${problems.length} problem(s):\n`);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(1);
