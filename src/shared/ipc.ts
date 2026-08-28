/**
 * IPC channel names. Both sides import from here so a rename cannot drift.
 *
 * `invoke`/`handle` channels are request-response; `on`/`send` channels push
 * from main to renderer.
 */
export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsReset: 'settings:reset',

  // credentials & auth
  authStatus: 'auth:status',
  authSetKey: 'auth:set-key',
  authClearKey: 'auth:clear-key',
  authImportFromCli: 'auth:import-from-cli',
  authOpenPortal: 'auth:open-portal',
  authCliLogin: 'auth:cli-login',
  authTest: 'auth:test',
  authImportable: 'auth:importable',

  // models
  modelsList: 'models:list',
  modelsRefresh: 'models:refresh',

  // chat
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event',

  // conversations
  convList: 'conv:list',
  convGet: 'conv:get',
  convCreate: 'conv:create',
  convUpdate: 'conv:update',
  convDelete: 'conv:delete',
  convExport: 'conv:export',

  // terminal
  termStart: 'term:start',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termKill: 'term:kill',
  termList: 'term:list',
  termEvent: 'term:event',

  // roundtable
  roomList: 'room:list',
  roomGet: 'room:get',
  roomCreate: 'room:create',
  roomUpdate: 'room:update',
  roomDelete: 'room:delete',
  roomExport: 'room:export',
  roomRun: 'room:run',
  roomAbort: 'room:abort',
  roomClose: 'room:close',
  roomEvent: 'room:event',
  roomTotals: 'room:totals',

  // telegram
  telegramStatus: 'telegram:status',
  telegramStart: 'telegram:start',
  telegramStop: 'telegram:stop',
  telegramSetToken: 'telegram:set-token',
  telegramUnpair: 'telegram:unpair',

  // misc
  diagnostics: 'app:diagnostics',
  pickDirectory: 'app:pick-directory',
  openExternal: 'app:open-external',
  navigate: 'app:navigate',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
