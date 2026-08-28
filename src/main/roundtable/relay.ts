import type { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc';
import type { RoundtableEvent } from '@shared/roundtable';

/**
 * One-way channel from the engine to the open window.
 *
 * A round started from Telegram had no path back to the renderer, so the app
 * sat there looking idle while the round ran: no Stop button, the composer
 * still armed, the transcript never gaining the round. Worse, the seat editors
 * are gated on that same "is a round running" flag, so a seat edited during a
 * Telegram round wrote the room file underneath the engine and was lost.
 *
 * It lives here rather than in `ipc-handlers.ts` because the bridge cannot
 * import that module — it already imports the bridge.
 */

let resolveWindow: () => BrowserWindow | null = () => null;

export function setRelayWindow(fn: () => BrowserWindow | null): void {
  resolveWindow = fn;
}

export function relayToWindow(event: RoundtableEvent): void {
  const window = resolveWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.roomEvent, event);
}
