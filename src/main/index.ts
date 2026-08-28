import { BrowserWindow, app } from 'electron';
import { IPC } from '@shared/ipc';
import { registerIpcHandlers } from './ipc-handlers';
import { buildMenu } from './menu';
import { createMainWindow } from './window';
import { configureAppPaths, LOG_DIR } from './store/paths';
import { initLogger, createLogger } from './util/logger';
import { killAllTerminals, onTerminalEvent } from './agents/terminal';
import { abortAll } from './providers/registry';
import { abortAllRooms } from './roundtable/engine';
import { startBridge, stopBridge } from './telegram/bridge';
import { loadSettings } from './store/settings';
import { runSmokeCheck } from './smoke';

// Paths must be pinned before anything reads app.getPath(), and the logger
// needs its directory to exist before the first log line.
configureAppPaths();
initLogger(LOG_DIR);

const log = createLogger('app');

let mainWindow: BrowserWindow | null = null;
const getWindow = () => mainWindow;

/**
 * A single instance owns the credential store and the running agent terminals.
 * A second launch — from the app launcher, or a desktop action — focuses the
 * existing window and forwards its intent instead of starting a rival process.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    routeFromArgv(argv);
  });

  // Electron's software rendering fallback is unusably slow under some Wayland
  // compositors; letting it pick GPU normally is right, but a user on a broken
  // driver needs an escape hatch that does not require rebuilding.
  if (process.env.GLM_STUDIO_DISABLE_GPU === '1') app.disableHardwareAcceleration();

  app.whenReady().then(() => {
    registerIpcHandlers(getWindow);
    buildMenu(getWindow);

    // Terminal output is high-frequency; forward it straight to the renderer
    // rather than buffering it in the main process.
    onTerminalEvent((event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.termEvent, event);
      }
    });

    mainWindow = createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    runSmokeCheck(mainWindow);

    mainWindow.webContents.once('did-finish-load', () => routeFromArgv(process.argv));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });

    // Reconnect the Telegram bridge if it was left enabled, so a remote watcher
    // does not have to open the app to restore it.
    if (loadSettings().telegram.enabled) {
      void startBridge().then((result) => {
        // Only the failure. The success message contains the live pairing code,
        // and the log is a plaintext file that outlives the code and gets
        // attached to bug reports.
        if (!result.ok) log.warn(`telegram: ${result.message}`);
      });
    }

    log.info(`GLM Studio ready (electron ${process.versions.electron})`);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    abortAll();
    abortAllRooms();
    stopBridge();
    killAllTerminals();
  });
}

/** Desktop actions in the .desktop file pass these flags. */
function routeFromArgv(argv: string[]): void {
  if (!mainWindow) return;
  if (argv.includes('--agent')) mainWindow.webContents.send(IPC.navigate, 'view-agents');
  else if (argv.includes('--new-chat')) mainWindow.webContents.send(IPC.navigate, 'new-chat');
}

process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason);
});
