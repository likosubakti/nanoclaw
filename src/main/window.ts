import { BrowserWindow, screen, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './store/paths';
import { createLogger } from './util/logger';

const log = createLogger('window');
const here = path.dirname(fileURLToPath(import.meta.url));
const BOUNDS_FILE = path.join(CONFIG_DIR, 'window-state.json');

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 860 };

function loadBounds(): Bounds {
  let bounds: Bounds;
  try {
    bounds = { ...DEFAULT_BOUNDS, ...JSON.parse(readFileSync(BOUNDS_FILE, 'utf8')) };
  } catch {
    return DEFAULT_BOUNDS;
  }

  // A window restored onto a monitor that is no longer attached is invisible
  // and looks like a crash, so clamp it back onto a display that exists.
  if (bounds.x !== undefined && bounds.y !== undefined) {
    const visible = screen.getAllDisplays().some((display) => {
      const a = display.workArea;
      return (
        bounds.x! < a.x + a.width &&
        bounds.x! + bounds.width > a.x &&
        bounds.y! < a.y + a.height &&
        bounds.y! + bounds.height > a.y
      );
    });
    if (!visible) {
      delete bounds.x;
      delete bounds.y;
    }
  }
  return bounds;
}

function saveBounds(window: BrowserWindow): void {
  try {
    const { x, y, width, height } = window.getNormalBounds();
    writeFileSync(
      BOUNDS_FILE,
      JSON.stringify({ x, y, width, height, maximized: window.isMaximized() }),
    );
  } catch (err) {
    log.debug('could not persist window bounds', err);
  }
}

export function createMainWindow(): BrowserWindow {
  const bounds = loadBounds();

  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: 'GLM Studio',
    // Painted before the renderer loads so startup does not flash white.
    backgroundColor: '#0b0f17',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(here, '../resources/icons/512x512.png'),
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs `require` for the IPC bridge
      spellcheck: true,
    },
  });

  if (bounds.maximized) window.maximize();

  window.once('ready-to-show', () => window.show());
  window.on('close', () => saveBounds(window));

  // Links in rendered Markdown open in the user's browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Defence in depth: a compromised renderer cannot navigate itself elsewhere.
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  void window.loadFile(path.join(here, '../renderer/index.html'));

  if (process.env.GLM_STUDIO_DEV === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}
