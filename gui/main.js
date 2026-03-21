const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Fix PATH for macOS GUI apps (Finder doesn't inherit shell PATH)
// ---------------------------------------------------------------------------
function fixPath() {
  const shells = ['/bin/zsh', '/bin/bash'];
  for (const sh of shells) {
    try {
      if (fs.existsSync(sh)) {
        const p = execSync(`${sh} -ilc 'echo $PATH'`, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (p && p.length > (process.env.PATH || '').length) {
          process.env.PATH = p;
          return;
        }
      }
    } catch {}
  }
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'];
  for (const p of extras) {
    if (fs.existsSync(p) && !(process.env.PATH || '').includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH}`;
    }
  }
}
fixPath();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const OC_DIR = path.join(HOME, '.openclaw');
const OC_CONFIG = path.join(OC_DIR, 'openclaw.json');
const OC_STORE = path.join(OC_DIR, 'manager-store.json');
const OC_LOGS_DIR = path.join(OC_DIR, 'logs');
const OC_CRON_DIR = path.join(OC_DIR, 'cron');
const OC_CRED_DIR = path.join(OC_DIR, 'credentials');
const PROJECT_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// JSON helpers (safe read/write)
// ---------------------------------------------------------------------------
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!dir || dir === '.') return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Manager store (local credentials — never pushed to git)
// ---------------------------------------------------------------------------
let store = readJson(OC_STORE) || {};

function saveStore() {
  writeJson(OC_STORE, store);
}

// ---------------------------------------------------------------------------
// OpenClaw config helpers
// ---------------------------------------------------------------------------
function readConfig() {
  return readJson(OC_CONFIG) || {};
}

function writeConfig(config) {
  // Backup before writing
  try {
    const existing = fs.readFileSync(OC_CONFIG, 'utf-8');
    fs.writeFileSync(OC_CONFIG + '.bak', existing);
  } catch {}
  writeJson(OC_CONFIG, config);
}

function patchConfig(patch) {
  const config = readConfig();
  deepMerge(config, patch);
  writeConfig(config);
  return config;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Shell command runner
// ---------------------------------------------------------------------------
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8', timeout: opts.timeout || 30000, ...opts }, (err, stdout, stderr) => {
      if (err && !opts.ignoreError) {
        resolve({ ok: false, error: stderr || err.message, stdout, stderr });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Gateway management
// ---------------------------------------------------------------------------
async function gatewayHealth() {
  const config = readConfig();
  const port = config.gateway?.port || 18789;
  const token = config.gateway?.auth?.token || '';
  try {
    const result = await runCmd(`curl -sf -m 3 http://127.0.0.1:${port}/health`, { timeout: 5000 });
    if (result.ok && result.stdout) {
      return { running: true, port, details: result.stdout.trim() };
    }
    // Fallback: check process
    const ps = await runCmd('pgrep -f "openclaw gateway"', { timeout: 3000, ignoreError: true });
    return { running: ps.stdout.trim().length > 0, port };
  } catch {
    return { running: false, port };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp login process tracking
// ---------------------------------------------------------------------------
let waLoginProcess = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Application menu
  const template = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ===========================================================================
// IPC HANDLERS
// ===========================================================================

// ---- Gateway ----
ipcMain.handle('oc:gateway-health', async () => gatewayHealth());

ipcMain.handle('oc:gateway-start', async () => {
  const health = await gatewayHealth();
  if (health.running) return { ok: true, already: true };
  const result = await runCmd('openclaw gateway start', { timeout: 15000 });
  // Give it a moment to spin up
  await new Promise(r => setTimeout(r, 2000));
  const check = await gatewayHealth();
  return { ok: check.running, ...result };
});

ipcMain.handle('oc:gateway-stop', async () => {
  const result = await runCmd('openclaw gateway stop', { timeout: 10000, ignoreError: true });
  return { ok: true, ...result };
});

ipcMain.handle('oc:gateway-restart', async () => {
  await runCmd('openclaw gateway stop', { timeout: 10000, ignoreError: true });
  await new Promise(r => setTimeout(r, 1000));
  const result = await runCmd('openclaw gateway start', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));
  const check = await gatewayHealth();
  return { ok: check.running, ...result };
});

// ---- Channels ----
ipcMain.handle('oc:channels-list', async () => {
  const result = await runCmd('openclaw channels list --json 2>/dev/null || openclaw channels list', { timeout: 10000 });
  if (result.ok) {
    try { return JSON.parse(result.stdout); } catch {}
    return result.stdout;
  }
  // Fallback: read from config
  const config = readConfig();
  return config.channels || {};
});

ipcMain.handle('oc:channels-status', async () => {
  const result = await runCmd('openclaw channels status --json 2>/dev/null || openclaw channels status', { timeout: 10000 });
  if (result.ok) {
    try { return JSON.parse(result.stdout); } catch {}
    return result.stdout;
  }
  return null;
});

ipcMain.handle('oc:channel-add-telegram', async (_, { token, account }) => {
  account = account || 'main';
  // Write token to config
  const config = readConfig();
  if (!config.channels) config.channels = {};
  if (!config.channels.telegram) config.channels.telegram = {};
  config.channels.telegram.enabled = true;
  config.channels.telegram.botToken = token;
  config.channels.telegram.dmPolicy = 'open';
  config.channels.telegram.allowFrom = ['*'];
  config.channels.telegram.groupAllowFrom = ['*'];
  config.channels.telegram.groupPolicy = 'open';
  config.channels.telegram.streaming = 'partial';
  if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};
  config.channels.telegram.accounts[account] = {
    enabled: true,
    botToken: token,
    dmPolicy: 'open',
    allowFrom: ['*'],
    groupAllowFrom: ['*'],
    groupPolicy: 'open',
    streaming: 'partial',
  };
  // Ensure plugin is enabled
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes('telegram')) config.plugins.allow.push('telegram');
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries.telegram = { enabled: true };

  writeConfig(config);

  // Store token in manager store
  store.telegram_token = token;
  store.telegram_account = account;
  saveStore();

  return { ok: true };
});

ipcMain.handle('oc:channel-login-whatsapp', async (_, { account }) => {
  account = account || 'main';
  // Enable WhatsApp in config
  const config = readConfig();
  if (!config.channels) config.channels = {};
  if (!config.channels.whatsapp) config.channels.whatsapp = {};
  config.channels.whatsapp.enabled = true;
  config.channels.whatsapp.dmPolicy = 'pairing';
  config.channels.whatsapp.groupPolicy = 'allowlist';
  config.channels.whatsapp.mediaMaxMb = 50;

  if (!config.plugins) config.plugins = {};
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes('whatsapp')) config.plugins.allow.push('whatsapp');
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries.whatsapp = { enabled: true };

  writeConfig(config);

  // Start WhatsApp login process — streams QR codes back to renderer
  return new Promise((resolve) => {
    if (waLoginProcess) {
      try { waLoginProcess.kill(); } catch {}
    }

    waLoginProcess = spawn('openclaw', ['channels', 'login', '--channel', 'whatsapp', '--account', account], {
      env: { ...process.env },
      timeout: 120000,
    });

    let output = '';

    waLoginProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Detect QR code lines (they contain block characters)
      if (text.includes('\u2588') || text.includes('\u2580') || text.includes('\u2584')) {
        mainWindow?.webContents.send('whatsapp:qr', { qr: text, raw: true });
      }
      // Detect success
      if (text.toLowerCase().includes('authenticated') || text.toLowerCase().includes('ready') || text.toLowerCase().includes('connected')) {
        mainWindow?.webContents.send('whatsapp:ready', { account });
      }
    });

    waLoginProcess.stderr.on('data', (data) => {
      output += data.toString();
    });

    waLoginProcess.on('close', (code) => {
      waLoginProcess = null;
      resolve({ ok: code === 0, output });
    });

    waLoginProcess.on('error', (err) => {
      waLoginProcess = null;
      resolve({ ok: false, error: err.message });
    });
  });
});

ipcMain.handle('oc:channel-remove', async (_, { channel, account }) => {
  const config = readConfig();
  if (config.channels && config.channels[channel]) {
    config.channels[channel].enabled = false;
    if (account && config.channels[channel].accounts) {
      delete config.channels[channel].accounts[account];
    }
    writeConfig(config);
  }
  return { ok: true };
});

// ---- Cron / Automations ----
ipcMain.handle('oc:cron-list', async () => {
  const jobsFile = path.join(OC_CRON_DIR, 'jobs.json');
  return readJson(jobsFile) || [];
});

ipcMain.handle('oc:cron-add', async (_, job) => {
  const jobsFile = path.join(OC_CRON_DIR, 'jobs.json');
  const jobs = readJson(jobsFile) || [];
  jobs.push({
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    channel: job.channel || 'telegram',
    target: job.target || '',
    enabled: true,
    created: new Date().toISOString(),
  });
  fs.mkdirSync(OC_CRON_DIR, { recursive: true });
  writeJson(jobsFile, jobs);
  return { ok: true };
});

ipcMain.handle('oc:cron-remove', async (_, { name }) => {
  const jobsFile = path.join(OC_CRON_DIR, 'jobs.json');
  let jobs = readJson(jobsFile) || [];
  jobs = jobs.filter(j => j.name !== name);
  writeJson(jobsFile, jobs);
  return { ok: true };
});

ipcMain.handle('oc:cron-toggle', async (_, { name, enabled }) => {
  const jobsFile = path.join(OC_CRON_DIR, 'jobs.json');
  const jobs = readJson(jobsFile) || [];
  const job = jobs.find(j => j.name === name);
  if (job) job.enabled = enabled;
  writeJson(jobsFile, jobs);
  return { ok: true };
});

ipcMain.handle('oc:cron-run', async (_, { name }) => {
  const result = await runCmd(`openclaw cron run "${name}"`, { timeout: 30000 });
  return result;
});

// ---- Config ----
ipcMain.handle('oc:config-read', () => readConfig());
ipcMain.handle('oc:config-write', (_, config) => { writeConfig(config); return { ok: true }; });
ipcMain.handle('oc:config-patch', (_, patch) => { patchConfig(patch); return { ok: true }; });

ipcMain.handle('oc:config-get', (_, { key }) => {
  const config = readConfig();
  return key.split('.').reduce((obj, k) => obj?.[k], config);
});

ipcMain.handle('oc:config-set', (_, { key, value }) => {
  const config = readConfig();
  const keys = key.split('.');
  let obj = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  writeConfig(config);
  return { ok: true };
});

// ---- Store (local credentials) ----
ipcMain.handle('store:get', (_, { key }) => store[key] ?? null);
ipcMain.handle('store:set', (_, { key, value }) => { store[key] = value; saveStore(); return { ok: true }; });
ipcMain.handle('store:get-all', () => store);
ipcMain.handle('store:delete', (_, { key }) => { delete store[key]; saveStore(); return { ok: true }; });

// ---- Logs ----
ipcMain.handle('oc:logs', async (_, { lines } = {}) => {
  lines = lines || 150;
  // Try gateway log first
  const logFiles = [
    path.join(OC_LOGS_DIR, 'gateway.log'),
    path.join(PROJECT_DIR, 'logs', 'nanoclaw.log'),
  ];
  for (const logFile of logFiles) {
    if (fs.existsSync(logFile)) {
      try {
        const result = execSync(`tail -${lines} "${logFile}"`, { encoding: 'utf-8', timeout: 5000 });
        return result;
      } catch {}
    }
  }
  return 'No log files found.';
});

ipcMain.handle('oc:logs-error', async () => {
  const errLog = path.join(OC_LOGS_DIR, 'gateway.err.log');
  if (fs.existsSync(errLog)) {
    try { return execSync(`tail -50 "${errLog}"`, { encoding: 'utf-8', timeout: 5000 }); } catch {}
  }
  return '';
});

// ---- Doctor / Diagnostics ----
ipcMain.handle('oc:doctor', async () => {
  const result = await runCmd('openclaw doctor', { timeout: 30000, ignoreError: true });
  return result.stdout || result.stderr || 'Doctor command not available.';
});

// ---- Message send ----
ipcMain.handle('oc:message-send', async (_, { channel, target, message }) => {
  const escaped = message.replace(/'/g, "'\\''");
  const result = await runCmd(`openclaw message send --channel ${channel} --target '${target}' --body '${escaped}'`, { timeout: 15000 });
  return result;
});

// ---- Skills ----
ipcMain.handle('oc:skills-list', async () => {
  const result = await runCmd('openclaw skills list --json 2>/dev/null || openclaw skills list', { timeout: 15000 });
  if (result.ok) {
    try { return JSON.parse(result.stdout); } catch {}
    return result.stdout;
  }
  return [];
});

ipcMain.handle('oc:skill-install', async (_, { slug }) => {
  const result = await runCmd(`openclaw skills install "${slug}"`, { timeout: 60000 });
  return result;
});

// ---- File system (for workspace files) ----
ipcMain.handle('oc:read-file', (_, { filePath }) => {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
});

ipcMain.handle('oc:write-file', (_, { filePath, content }) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---- Paths & navigation ----
ipcMain.handle('oc:get-paths', () => ({
  home: HOME,
  ocDir: OC_DIR,
  projectDir: PROJECT_DIR,
  logsDir: OC_LOGS_DIR,
  cronDir: OC_CRON_DIR,
  credDir: OC_CRED_DIR,
}));

ipcMain.handle('oc:open-folder', (_, dir) => shell.openPath(dir || PROJECT_DIR));
ipcMain.handle('oc:open-external', (_, url) => shell.openExternal(url));

// ---- Check what's installed ----
ipcMain.handle('oc:check-deps', async () => {
  const checks = {};
  // Node
  try {
    checks.node = execSync('node --version', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch { checks.node = null; }
  // OpenClaw
  try {
    checks.openclaw = execSync('openclaw --version 2>/dev/null || echo ""', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { checks.openclaw = null; }
  // WhatsApp auth
  checks.whatsappAuth = fs.existsSync(path.join(OC_CRED_DIR, 'whatsapp'))
    && fs.readdirSync(path.join(OC_CRED_DIR, 'whatsapp')).length > 0;
  // Telegram config
  const config = readConfig();
  checks.telegramConfigured = !!(config.channels?.telegram?.botToken);
  // NanoClaw project
  checks.nanoclawProject = fs.existsSync(path.join(PROJECT_DIR, 'package.json'));
  checks.nanoclawBuilt = fs.existsSync(path.join(PROJECT_DIR, 'dist', 'index.js'));
  // NanoClaw WhatsApp auth
  checks.nanoclawWhatsAppAuth = fs.existsSync(path.join(PROJECT_DIR, 'store', 'auth', 'creds.json'));

  return checks;
});

// ---- NanoClaw service management (alternative to OpenClaw gateway) ----
let ncProcess = null;

ipcMain.handle('nc:start', async () => {
  // Check if already running
  try {
    const ps = execSync('pgrep -f "node dist/index.js"', { encoding: 'utf-8', timeout: 3000 });
    if (ps.trim()) return { ok: true, already: true };
  } catch {}
  ncProcess = spawn('node', ['dist/index.js'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Pipe stdout/stderr to log file
  const logDir = path.join(PROJECT_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'nanoclaw.log'), { flags: 'a' });
  ncProcess.stdout.pipe(logStream);
  ncProcess.stderr.pipe(logStream);
  ncProcess.unref();
  return { ok: true, pid: ncProcess.pid };
});

ipcMain.handle('nc:stop', async () => {
  try {
    execSync('pkill -f "node dist/index.js"', { timeout: 5000 });
    ncProcess = null;
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('nc:status', async () => {
  try {
    const ps = execSync('pgrep -f "node dist/index.js"', { encoding: 'utf-8', timeout: 3000 });
    return { running: ps.trim().length > 0 };
  } catch { return { running: false }; }
});

// ---- NanoClaw .env management ----
ipcMain.handle('nc:read-env', () => {
  const envFile = path.join(PROJECT_DIR, '.env');
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    const result = {};
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      result[t.slice(0, eq).trim()] = val;
    }
    return result;
  } catch { return {}; }
});

ipcMain.handle('nc:write-env', (_, data) => {
  const envFile = path.join(PROJECT_DIR, '.env');
  const lines = Object.entries(data).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  // Sync to container env
  const envDir = path.join(PROJECT_DIR, 'data', 'env');
  fs.mkdirSync(envDir, { recursive: true });
  fs.copyFileSync(envFile, path.join(envDir, 'env'));
  return { ok: true };
});

// ---- NanoClaw WhatsApp auth ----
ipcMain.handle('nc:whatsapp-auth', async (_, { method }) => {
  // method: 'qr-browser' | 'qr-terminal' | 'pairing-code'
  method = method || 'qr-browser';
  const args = ['tsx', 'setup/index.ts', '--step', 'whatsapp-auth', '--', '--method', method];

  return new Promise((resolve) => {
    const proc = spawn('npx', args, { cwd: PROJECT_DIR, timeout: 150000 });
    let output = '';
    proc.stdout.on('data', (d) => {
      const t = d.toString();
      output += t;
      if (t.includes('Authenticated') || t.includes('AUTH_STATUS: authenticated')) {
        mainWindow?.webContents.send('whatsapp:ready', {});
      }
    });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, output }));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ---- NanoClaw group registration ----
ipcMain.handle('nc:register-group', async (_, opts) => {
  const args = [
    'tsx', 'setup/index.ts', '--step', 'register',
    '--', '--jid', opts.jid,
    '--name', opts.name,
    '--folder', opts.folder,
    '--trigger', opts.trigger || '@Andy',
    '--channel', opts.channel || 'whatsapp',
  ];
  if (opts.isMain) args.push('--is-main', '--no-trigger-required');
  if (opts.assistantName) args.push('--assistant-name', opts.assistantName);

  const result = await runCmd(`cd "${PROJECT_DIR}" && npx ${args.join(' ')}`, { timeout: 15000 });
  return result;
});

// ---- NanoClaw groups from DB ----
ipcMain.handle('nc:groups', async () => {
  const dbPath = path.join(PROJECT_DIR, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return {};
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT jid, json FROM registered_groups"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const groups = {};
    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const sep = line.indexOf('|');
      if (sep === -1) continue;
      try { groups[line.slice(0, sep)] = JSON.parse(line.slice(sep + 1)); } catch {}
    }
    return groups;
  } catch { return {}; }
});

// ---- NanoClaw message stats ----
ipcMain.handle('nc:message-stats', async () => {
  const dbPath = path.join(PROJECT_DIR, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return { total: 0, today: 0 };
  try {
    const total = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM messages"`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const today = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM messages WHERE timestamp > datetime('now', '-1 day')"`, { encoding: 'utf-8', timeout: 5000 }).trim();
    return { total: parseInt(total) || 0, today: parseInt(today) || 0 };
  } catch { return { total: 0, today: 0 }; }
});

// ---- NanoClaw tasks from DB ----
ipcMain.handle('nc:tasks', async () => {
  const dbPath = path.join(PROJECT_DIR, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT id, group_folder, prompt, schedule_type, schedule_value, status, next_run FROM tasks"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return result.trim().split('\n').filter(Boolean).map(line => {
      const [id, group_folder, prompt, schedule_type, schedule_value, status, next_run] = line.split('|');
      return { id, group_folder, prompt, schedule_type, schedule_value, status, next_run };
    });
  } catch { return []; }
});

// ---- Build NanoClaw ----
ipcMain.handle('nc:build', async () => {
  const result = await runCmd(`cd "${PROJECT_DIR}" && npm run build`, { timeout: 60000 });
  return result;
});

// ---- Select folder dialog ----
ipcMain.handle('oc:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});
