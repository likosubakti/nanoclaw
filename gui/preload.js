const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oc', {
  // ---- OpenClaw Gateway ----
  gatewayHealth: () => ipcRenderer.invoke('oc:gateway-health'),
  gatewayStart: () => ipcRenderer.invoke('oc:gateway-start'),
  gatewayStop: () => ipcRenderer.invoke('oc:gateway-stop'),
  gatewayRestart: () => ipcRenderer.invoke('oc:gateway-restart'),

  // ---- Channels ----
  channelsList: () => ipcRenderer.invoke('oc:channels-list'),
  channelsStatus: () => ipcRenderer.invoke('oc:channels-status'),
  channelAddTelegram: (token, account) => ipcRenderer.invoke('oc:channel-add-telegram', { token, account }),
  channelLoginWhatsApp: (account) => ipcRenderer.invoke('oc:channel-login-whatsapp', { account }),
  channelRemove: (channel, account) => ipcRenderer.invoke('oc:channel-remove', { channel, account }),
  messageSend: (channel, target, message) => ipcRenderer.invoke('oc:message-send', { channel, target, message }),

  // ---- Cron / Automations ----
  cronList: () => ipcRenderer.invoke('oc:cron-list'),
  cronAdd: (job) => ipcRenderer.invoke('oc:cron-add', job),
  cronRemove: (name) => ipcRenderer.invoke('oc:cron-remove', { name }),
  cronToggle: (name, enabled) => ipcRenderer.invoke('oc:cron-toggle', { name, enabled }),
  cronRun: (name) => ipcRenderer.invoke('oc:cron-run', { name }),

  // ---- Config ----
  configRead: () => ipcRenderer.invoke('oc:config-read'),
  configWrite: (config) => ipcRenderer.invoke('oc:config-write', config),
  configPatch: (patch) => ipcRenderer.invoke('oc:config-patch', patch),
  configGet: (key) => ipcRenderer.invoke('oc:config-get', { key }),
  configSet: (key, value) => ipcRenderer.invoke('oc:config-set', { key, value }),

  // ---- Store (local credentials) ----
  storeGet: (key) => ipcRenderer.invoke('store:get', { key }),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', { key, value }),
  storeGetAll: () => ipcRenderer.invoke('store:get-all'),
  storeDelete: (key) => ipcRenderer.invoke('store:delete', { key }),

  // ---- Logs ----
  logs: (lines) => ipcRenderer.invoke('oc:logs', { lines }),
  logsError: () => ipcRenderer.invoke('oc:logs-error'),

  // ---- Doctor ----
  doctor: () => ipcRenderer.invoke('oc:doctor'),

  // ---- Skills ----
  skillsList: () => ipcRenderer.invoke('oc:skills-list'),
  skillInstall: (slug) => ipcRenderer.invoke('oc:skill-install', { slug }),

  // ---- Paths ----
  getPaths: () => ipcRenderer.invoke('oc:get-paths'),
  openFolder: (dir) => ipcRenderer.invoke('oc:open-folder', dir),
  openExternal: (url) => ipcRenderer.invoke('oc:open-external', url),
  selectFolder: () => ipcRenderer.invoke('oc:select-folder'),
  checkDeps: () => ipcRenderer.invoke('oc:check-deps'),

  // ---- Files ----
  readFile: (filePath) => ipcRenderer.invoke('oc:read-file', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('oc:write-file', { filePath, content }),

  // ---- NanoClaw Service ----
  ncStart: () => ipcRenderer.invoke('nc:start'),
  ncStop: () => ipcRenderer.invoke('nc:stop'),
  ncStatus: () => ipcRenderer.invoke('nc:status'),
  ncBuild: () => ipcRenderer.invoke('nc:build'),
  ncReadEnv: () => ipcRenderer.invoke('nc:read-env'),
  ncWriteEnv: (data) => ipcRenderer.invoke('nc:write-env', data),
  ncWhatsAppAuth: (opts) => ipcRenderer.invoke('nc:whatsapp-auth', opts),
  ncRegisterGroup: (opts) => ipcRenderer.invoke('nc:register-group', opts),
  ncGroups: () => ipcRenderer.invoke('nc:groups'),
  ncTasks: () => ipcRenderer.invoke('nc:tasks'),
  ncMessageStats: () => ipcRenderer.invoke('nc:message-stats'),

  // ---- Ollama ----
  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  ollamaChat: (model, message) => ipcRenderer.invoke('ollama:chat', { model, message }),
  ollamaGenerate: (model, prompt) => ipcRenderer.invoke('ollama:generate', { model, prompt }),
  ollamaConfigure: (model, baseUrl) => ipcRenderer.invoke('ollama:configure', { model, baseUrl }),

  // ---- Events ----
  onWhatsAppQR: (cb) => ipcRenderer.on('whatsapp:qr', (_, d) => cb(d)),
  onWhatsAppReady: (cb) => ipcRenderer.on('whatsapp:ready', (_, d) => cb(d)),
  onWhatsAppFailed: (cb) => ipcRenderer.on('whatsapp:failed', (_, d) => cb(d)),
  offWhatsAppQR: () => ipcRenderer.removeAllListeners('whatsapp:qr'),
  offWhatsAppReady: () => ipcRenderer.removeAllListeners('whatsapp:ready'),
  offWhatsAppFailed: () => ipcRenderer.removeAllListeners('whatsapp:failed'),
});
