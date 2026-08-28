import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import type {
  AppSettings,
  ChatRequest,
  Conversation,
  ProviderId,
  StreamEvent,
  TerminalSpec,
  Transport,
} from '@shared/types';
import { IPC } from '@shared/ipc';
import type { Room, RoundMode, RoundtableEvent } from '@shared/roundtable';
import { MODEL_CATALOG, PROVIDER_ORDER } from '@shared/models';
import { importableKey, openKeyPortal, providerStatus, startCliLogin } from './auth/login-flows';
import { abortChat, refreshModels, runChat, testProvider } from './providers/registry';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversation,
  toMarkdown,
} from './store/conversations';
import { clearSecret, secretsBackend, setSecret } from './store/secrets';
import { loadSettings, resetSettings, saveSettings, unpairChat } from './store/settings';
import {
  killTerminal,
  listTerminals,
  ptyAvailable,
  resizeTerminal,
  startTerminal,
  writeTerminal,
} from './agents/terminal';
import { abortRoom, isRunning, runRound, totalsFor } from './roundtable/engine';
import { sanitizeRoom } from './roundtable/validate';
import {
  createRoom,
  deleteRoom,
  getRoom,
  listRooms,
  roomToMarkdown,
  saveRoom,
} from './roundtable/store';
import {
  bridgeStatus,
  broadcast,
  PAIRING_TTL_MS,
  revokePairingCode,
  rotatePairingCode,
  startBridge,
  stopBridge,
} from './telegram/bridge';
import { CONFIG_DIR, DATA_DIR } from './store/paths';
import { createLogger } from './util/logger';

const log = createLogger('ipc');

/** Anything a renderer sends is untrusted input; validate before it reaches a store. */
function assertProvider(value: unknown): ProviderId {
  if (value === 'glm' || value === 'anthropic' || value === 'openai') return value;
  throw new Error(`Unknown provider: ${String(value)}`);
}

function assertRoundMode(value: unknown): RoundMode {
  const modes = ['parallel', 'sequential', 'critique', 'synthesis', 'direct'];
  if (typeof value === 'string' && modes.includes(value)) return value as RoundMode;
  throw new Error(`Unknown round mode: ${String(value)}`);
}

function assertTransport(value: unknown): Transport {
  if (value === 'api' || value === 'cli') return value;
  throw new Error(`Unknown transport: ${String(value)}`);
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------------------------------------ settings -- */

  ipcMain.handle(IPC.settingsGet, () => loadSettings());
  ipcMain.handle(IPC.settingsSet, (_event, patch: Partial<AppSettings>) => saveSettings(patch));
  ipcMain.handle(IPC.settingsReset, () => resetSettings());

  /* ---------------------------------------------------------------- auth -- */

  ipcMain.handle(IPC.authStatus, async () =>
    Promise.all(PROVIDER_ORDER.map((provider) => providerStatus(provider))),
  );

  ipcMain.handle(IPC.authSetKey, (_event, provider: unknown, key: unknown) => {
    const id = assertProvider(provider);
    setSecret(`${id}.apiKey`, String(key ?? ''));
    log.info(`stored API key for ${id} (${secretsBackend()} backend)`);
    return providerStatus(id);
  });

  ipcMain.handle(IPC.authClearKey, (_event, provider: unknown) => {
    const id = assertProvider(provider);
    clearSecret(`${id}.apiKey`);
    return providerStatus(id);
  });

  ipcMain.handle(IPC.authImportFromCli, (_event, provider: unknown) => {
    const id = assertProvider(provider);
    const found = importableKey(id);
    if (!found) return { imported: false, status: providerStatus(id) };
    setSecret(`${id}.apiKey`, found.key);
    log.info(`imported ${id} key from ${found.source}`);
    return { imported: true, source: found.source, status: providerStatus(id) };
  });

  // Returns what *could* be imported so the UI can ask before doing it.
  ipcMain.handle(IPC.authImportable, (_event, provider: unknown) => {
    const found = importableKey(assertProvider(provider));
    return found ? { masked: found.masked, source: found.source } : null;
  });

  ipcMain.handle(IPC.authOpenPortal, (_event, provider: unknown) => {
    openKeyPortal(assertProvider(provider), getWindow() ?? undefined);
  });

  ipcMain.handle(IPC.authCliLogin, (_event, provider: unknown) =>
    startCliLogin(assertProvider(provider)),
  );

  ipcMain.handle(IPC.authTest, (_event, provider: unknown, transport: unknown) =>
    testProvider(assertProvider(provider), assertTransport(transport)),
  );

  /* -------------------------------------------------------------- models -- */

  ipcMain.handle(IPC.modelsList, () => MODEL_CATALOG);
  ipcMain.handle(IPC.modelsRefresh, async (_event, provider: unknown) => {
    try {
      return await refreshModels(assertProvider(provider));
    } catch (err) {
      log.warn('model refresh failed', err);
      return [];
    }
  });

  /* ---------------------------------------------------------------- chat -- */

  ipcMain.handle(IPC.chatSend, async (event, request: ChatRequest) => {
    const sender = event.sender;
    const emit = (streamEvent: StreamEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC.chatEvent, streamEvent);
    };
    // Not awaited: the renderer follows the turn through chat:event, and
    // awaiting here would block the IPC reply for the whole completion.
    void runChat(
      {
        ...request,
        provider: assertProvider(request.provider),
        transport: assertTransport(request.transport),
      },
      emit,
    );
    return { accepted: true };
  });

  ipcMain.handle(IPC.chatAbort, (_event, streamId: unknown) => abortChat(String(streamId)));

  /* ------------------------------------------------------- conversations -- */

  ipcMain.handle(IPC.convList, () => listConversations());
  ipcMain.handle(IPC.convGet, (_event, id: unknown) => getConversation(String(id)));
  ipcMain.handle(
    IPC.convCreate,
    (_event, input: { provider: ProviderId; model: string; transport: Transport; cwd?: string }) =>
      createConversation({
        provider: assertProvider(input.provider),
        model: String(input.model),
        transport: assertTransport(input.transport),
        cwd: input.cwd,
      }),
  );
  ipcMain.handle(IPC.convUpdate, (_event, conversation: Conversation) =>
    saveConversation(conversation),
  );
  ipcMain.handle(IPC.convDelete, (_event, id: unknown) => {
    deleteConversation(String(id));
    return listConversations();
  });

  ipcMain.handle(IPC.convExport, async (_event, id: unknown) => {
    const conversation = getConversation(String(id));
    if (!conversation) return { saved: false };

    const window = getWindow();
    const suggested = `${conversation.title.replace(/[^\w\d -]/g, '').trim() || 'conversation'}.md`;
    const options = {
      title: 'Export conversation',
      defaultPath: suggested,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };

    await writeFile(result.filePath, toMarkdown(conversation), 'utf8');
    return { saved: true, path: result.filePath };
  });

  /* ------------------------------------------------------------ terminal -- */

  ipcMain.handle(IPC.termStart, (_event, spec: TerminalSpec) =>
    startTerminal({ ...spec, provider: assertProvider(spec.provider) }),
  );
  ipcMain.handle(IPC.termWrite, (_event, id: unknown, data: unknown) =>
    writeTerminal(String(id), String(data)),
  );
  ipcMain.handle(IPC.termResize, (_event, id: unknown, cols: unknown, rows: unknown) =>
    resizeTerminal(String(id), Number(cols), Number(rows)),
  );
  ipcMain.handle(IPC.termKill, (_event, id: unknown) => killTerminal(String(id)));
  ipcMain.handle(IPC.termList, () => listTerminals());

  /* ---------------------------------------------------------- roundtable -- */

  ipcMain.handle(IPC.roomList, () => listRooms());
  ipcMain.handle(IPC.roomGet, (_event, id: unknown) => getRoom(String(id)));
  ipcMain.handle(IPC.roomCreate, (_event, topic: unknown) =>
    createRoom({ topic: String(topic ?? '').slice(0, 4000) }),
  );
  ipcMain.handle(IPC.roomUpdate, (_event, room: Room) => {
    // The renderer sends a whole Room; never trust it. Load the stored one by
    // its id and fold only validated fields onto it.
    const existing = getRoom(String(room?.id ?? ''));
    if (!existing) throw new Error('Room not found.');
    return saveRoom(sanitizeRoom(room, existing));
  });
  ipcMain.handle(IPC.roomDelete, (_event, id: unknown) => {
    deleteRoom(String(id));
    return listRooms();
  });

  ipcMain.handle(
    IPC.roomRun,
    async (
      event,
      input: { roomId: string; mode: RoundMode; message: string; seatIds?: string[] },
    ) => {
      const sender = event.sender;
      const emit = (roundtableEvent: RoundtableEvent) => {
        if (!sender.isDestroyed()) sender.send(IPC.roomEvent, roundtableEvent);
        // Rounds started in the app are mirrored to Telegram too, so the phone
        // view is a live window on the room rather than a separate channel.
        void broadcast(roundtableEvent);
      };
      // Not awaited: a round can run for minutes, and the renderer follows it
      // through room:event. Awaiting here would block the IPC channel.
      void runRound(
        {
          roomId: String(input.roomId),
          mode: assertRoundMode(input.mode),
          message: String(input.message ?? ''),
          seatIds: Array.isArray(input.seatIds) ? input.seatIds.map(String) : undefined,
        },
        emit,
      );
      return { accepted: true };
    },
  );

  ipcMain.handle(IPC.roomAbort, (_event, id: unknown) => abortRoom(String(id)));

  ipcMain.handle(IPC.roomClose, (_event, id: unknown) => {
    const room = getRoom(String(id));
    if (!room) return null;
    abortRoom(room.id);
    room.status = 'closed';
    return saveRoom(room);
  });

  ipcMain.handle(IPC.roomTotals, (_event, id: unknown) => {
    const room = getRoom(String(id));
    return room ? { totals: totalsFor(room), running: isRunning(room.id) } : null;
  });

  ipcMain.handle(IPC.roomExport, async (_event, id: unknown) => {
    const room = getRoom(String(id));
    if (!room) return { saved: false };

    const window = getWindow();
    const options = {
      title: 'Export discussion',
      defaultPath: `${room.title.replace(/[^\w\d -]/g, '').trim() || 'discussion'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };

    await writeFile(result.filePath, roomToMarkdown(room), 'utf8');
    return { saved: true, path: result.filePath };
  });

  /* ------------------------------------------------------------ telegram -- */

  ipcMain.handle(IPC.telegramStatus, () => bridgeStatus());
  ipcMain.handle(IPC.telegramStart, () => startBridge());
  ipcMain.handle(IPC.telegramStop, () => {
    stopBridge();
    return bridgeStatus();
  });

  ipcMain.handle(IPC.telegramSetToken, (_event, token: unknown) => {
    setSecret('telegram.botToken', String(token ?? ''));
    return bridgeStatus();
  });

  ipcMain.handle(IPC.telegramNewCode, () => ({
    pairingCode: rotatePairingCode(),
    expiresInMs: PAIRING_TTL_MS,
  }));

  ipcMain.handle(IPC.telegramUnpair, (_event, chatId: unknown) => {
    const settings = unpairChat(Number(chatId));
    // Unpairing that did not revoke the code left the chat able to simply
    // re-pair with the same six digits it already had.
    revokePairingCode();
    return settings;
  });

  /* ---------------------------------------------------------------- misc -- */

  ipcMain.handle(IPC.diagnostics, async () => ({
    appVersion: process.env.npm_package_version ?? '0.1.0',
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    configDir: CONFIG_DIR,
    dataDir: DATA_DIR,
    secretsBackend: secretsBackend(),
    ptyAvailable: ptyAvailable(),
    providers: await Promise.all(PROVIDER_ORDER.map((p) => providerStatus(p))),
  }));

  ipcMain.handle(IPC.pickDirectory, async (_event, current?: string) => {
    const window = getWindow();
    const options = {
      title: 'Choose a working directory',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    const target = String(url);
    // Only ever hand https/mailto to the desktop; file:// and custom schemes
    // from renderer content would be an execution vector.
    if (/^(https?|mailto):/i.test(target)) void shell.openExternal(target);
  });
}
