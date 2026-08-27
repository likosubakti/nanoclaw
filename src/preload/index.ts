import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc';
import type {
  AppSettings,
  ChatRequest,
  ConnectionTestResult,
  Conversation,
  ConversationSummary,
  Diagnostics,
  ModelInfo,
  ProviderId,
  ProviderStatus,
  StreamEvent,
  TerminalEvent,
  TerminalInfo,
  TerminalSpec,
  Transport,
} from '@shared/types';

/**
 * The only surface the renderer gets. Every entry is an explicit, typed call —
 * there is no generic `invoke(channel, …)` escape hatch, so a cross-site
 * scripting bug in rendered Markdown cannot reach an arbitrary IPC handler.
 */
const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
    reset: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsReset),
  },

  auth: {
    status: (): Promise<ProviderStatus[]> => ipcRenderer.invoke(IPC.authStatus),
    setKey: (provider: ProviderId, key: string): Promise<ProviderStatus> =>
      ipcRenderer.invoke(IPC.authSetKey, provider, key),
    clearKey: (provider: ProviderId): Promise<ProviderStatus> =>
      ipcRenderer.invoke(IPC.authClearKey, provider),
    importable: (
      provider: ProviderId,
    ): Promise<{ masked: string; source: string } | null> =>
      ipcRenderer.invoke('auth:importable', provider),
    importFromCli: (
      provider: ProviderId,
    ): Promise<{ imported: boolean; source?: string; status: ProviderStatus }> =>
      ipcRenderer.invoke(IPC.authImportFromCli, provider),
    openPortal: (provider: ProviderId): Promise<void> =>
      ipcRenderer.invoke(IPC.authOpenPortal, provider),
    cliLogin: (provider: ProviderId): Promise<TerminalInfo> =>
      ipcRenderer.invoke(IPC.authCliLogin, provider),
    test: (provider: ProviderId, transport: Transport): Promise<ConnectionTestResult> =>
      ipcRenderer.invoke(IPC.authTest, provider, transport),
  },

  models: {
    list: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.modelsList),
    refresh: (provider: ProviderId): Promise<ModelInfo[]> =>
      ipcRenderer.invoke(IPC.modelsRefresh, provider),
  },

  chat: {
    send: (request: ChatRequest): Promise<{ accepted: boolean }> =>
      ipcRenderer.invoke(IPC.chatSend, request),
    abort: (streamId: string): Promise<boolean> => ipcRenderer.invoke(IPC.chatAbort, streamId),
    onEvent: (handler: (event: StreamEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: StreamEvent) => handler(event);
      ipcRenderer.on(IPC.chatEvent, listener);
      return () => ipcRenderer.removeListener(IPC.chatEvent, listener);
    },
  },

  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke(IPC.convList),
    get: (id: string): Promise<Conversation | null> => ipcRenderer.invoke(IPC.convGet, id),
    create: (input: {
      provider: ProviderId;
      model: string;
      transport: Transport;
      cwd?: string;
    }): Promise<Conversation> => ipcRenderer.invoke(IPC.convCreate, input),
    update: (conversation: Conversation): Promise<Conversation> =>
      ipcRenderer.invoke(IPC.convUpdate, conversation),
    remove: (id: string): Promise<ConversationSummary[]> => ipcRenderer.invoke(IPC.convDelete, id),
    export: (id: string): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.convExport, id),
  },

  terminal: {
    start: (spec: TerminalSpec): Promise<TerminalInfo> => ipcRenderer.invoke(IPC.termStart, spec),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke(IPC.termWrite, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.termResize, id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.termKill, id),
    list: (): Promise<TerminalInfo[]> => ipcRenderer.invoke(IPC.termList),
    onEvent: (handler: (event: TerminalEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: TerminalEvent) => handler(event);
      ipcRenderer.on(IPC.termEvent, listener);
      return () => ipcRenderer.removeListener(IPC.termEvent, listener);
    },
  },

  app: {
    diagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(IPC.diagnostics),
    pickDirectory: (current?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.pickDirectory, current),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
    onNavigate: (handler: (route: string) => void): (() => void) => {
      const listener = (_e: unknown, route: string) => handler(route);
      ipcRenderer.on(IPC.navigate, listener);
      return () => ipcRenderer.removeListener(IPC.navigate, listener);
    },
  },
};

contextBridge.exposeInMainWorld('glm', api);

export type GlmApi = typeof api;
