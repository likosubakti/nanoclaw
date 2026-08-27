import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * XDG-correct locations. Electron's defaults capitalise the product name
 * ("~/.config/GLM Studio"), which is awkward to type in a terminal, so the
 * paths are pinned to a lowercase slug before any of them is read.
 */
const SLUG = 'glm-studio';

function xdg(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  return value && path.isAbsolute(value) ? value : fallback;
}

const home = os.homedir();

export const CONFIG_DIR = path.join(xdg('XDG_CONFIG_HOME', path.join(home, '.config')), SLUG);
export const DATA_DIR = path.join(
  xdg('XDG_DATA_HOME', path.join(home, '.local', 'share')),
  SLUG,
);
export const CACHE_DIR = path.join(xdg('XDG_CACHE_HOME', path.join(home, '.cache')), SLUG);
export const STATE_DIR = path.join(
  xdg('XDG_STATE_HOME', path.join(home, '.local', 'state')),
  SLUG,
);

export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
export const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json');
export const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
export const LOG_DIR = STATE_DIR;

/** Must run before anything touches app.getPath('userData'). */
export function configureAppPaths(): void {
  app.setName('GLM Studio');
  for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR, STATE_DIR, CONVERSATIONS_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  app.setPath('userData', CONFIG_DIR);
  app.setPath('sessionData', path.join(CACHE_DIR, 'session'));
  app.setPath('logs', LOG_DIR);
}

/** Default workspace for agent terminals: a real directory, never `/`. */
export function defaultWorkspace(): string {
  const override = process.env.GLM_STUDIO_WORKSPACE;
  if (override && path.isAbsolute(override) && existsSync(override)) return override;
  for (const name of ['Projects', 'projects', 'workspace', 'src', 'dev']) {
    const candidate = path.join(home, name);
    if (existsSync(candidate)) return candidate;
  }
  return home;
}
