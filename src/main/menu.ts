import { Menu, type BrowserWindow, shell } from 'electron';
import { IPC } from '@shared/ipc';
import { CONFIG_DIR, LOG_DIR } from './store/paths';

/**
 * A conventional menu bar. It is auto-hidden (Alt reveals it) so the window
 * stays clean, but keeping it means the standard editing shortcuts and
 * accessibility tooling behave as users expect.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (route: string) => () => getWindow()?.webContents.send(IPC.navigate, route);

  const menu = Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
        { label: 'New Agent Terminal', accelerator: 'CmdOrCtrl+T', click: send('new-terminal') },
        { type: 'separator' },
        { label: 'Export Conversation…', accelerator: 'CmdOrCtrl+S', click: send('export') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Chat', accelerator: 'CmdOrCtrl+1', click: send('view-chat') },
        { label: 'Roundtable', accelerator: 'CmdOrCtrl+2', click: send('view-roundtable') },
        { label: 'Agents', accelerator: 'CmdOrCtrl+3', click: send('view-agents') },
        { label: 'Login & Providers', accelerator: 'CmdOrCtrl+4', click: send('view-login') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Open Config Folder',
          click: () => void shell.openPath(CONFIG_DIR),
        },
        {
          label: 'Open Log Folder',
          click: () => void shell.openPath(LOG_DIR),
        },
        { type: 'separator' },
        {
          label: 'Z.ai Documentation',
          click: () => void shell.openExternal('https://docs.z.ai'),
        },
        {
          label: 'Claude Code Documentation',
          click: () => void shell.openExternal('https://docs.claude.com/en/docs/claude-code'),
        },
        {
          label: 'Codex CLI Documentation',
          click: () => void shell.openExternal('https://developers.openai.com/codex/cli'),
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}
