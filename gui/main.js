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
// Paths — detect NanoClaw project root (works from DMG and dev mode)
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const OC_DIR = path.join(HOME, '.openclaw');
const OC_CONFIG = path.join(OC_DIR, 'openclaw.json');
const OC_STORE = path.join(OC_DIR, 'manager-store.json');
const OC_LOGS_DIR = path.join(OC_DIR, 'logs');
const OC_CRON_DIR = path.join(OC_DIR, 'cron');
const OC_CRED_DIR = path.join(OC_DIR, 'credentials');

// Settings file for persistent config (survives reinstalls)
const SETTINGS_FILE = path.join(HOME, '.config', 'nanoclaw', 'gui-settings.json');

function detectProjectDir() {
  // 1. Check saved setting
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    if (settings.projectDir && fs.existsSync(path.join(settings.projectDir, 'package.json'))) {
      return settings.projectDir;
    }
  } catch {}

  // 2. Dev mode — __dirname is inside gui/, parent has package.json
  const devCandidate = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(devCandidate, 'package.json')) &&
      fs.existsSync(path.join(devCandidate, 'src', 'index.ts'))) {
    return devCandidate;
  }

  // 3. Search known locations
  const candidates = [
    path.join(HOME, 'SynologyDrive', 'Nanoclaw'),
    path.join(HOME, 'nanoclaw'),
    path.join(HOME, 'Developer', 'Nanoclaw'),
    path.join(HOME, 'Documents', 'Developer', 'Nanoclaw'),
    path.join(HOME, 'Projects', 'Nanoclaw'),
    path.join(HOME, 'Code', 'Nanoclaw'),
    path.join(HOME, 'Desktop', 'Nanoclaw'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json')) &&
        fs.existsSync(path.join(dir, 'src', 'index.ts'))) {
      return dir;
    }
  }

  // 4. Fallback to dev mode path
  return devCandidate;
}

let PROJECT_DIR = detectProjectDir();

function saveProjectDir(dir) {
  PROJECT_DIR = dir;
  const settingsDir = path.dirname(SETTINGS_FILE);
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ projectDir: dir }, null, 2));
}

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
  const checks = { projectDir: PROJECT_DIR };
  // Node
  try {
    checks.node = execSync('node --version', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch { checks.node = null; }
  // OpenClaw
  try {
    checks.openclaw = execSync('openclaw --version 2>/dev/null || echo ""', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { checks.openclaw = null; }
  // WhatsApp auth (OpenClaw)
  try {
    checks.whatsappAuth = fs.existsSync(path.join(OC_CRED_DIR, 'whatsapp'))
      && fs.readdirSync(path.join(OC_CRED_DIR, 'whatsapp')).length > 0;
  } catch { checks.whatsappAuth = false; }
  // Telegram config
  const config = readConfig();
  checks.telegramConfigured = !!(config.channels?.telegram?.botToken);
  // Also check .env for telegram token
  try {
    const envContent = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf-8');
    if (envContent.includes('TELEGRAM_BOT_TOKEN=') && !envContent.includes('TELEGRAM_BOT_TOKEN=\n')) {
      checks.telegramConfigured = true;
    }
  } catch {}
  // NanoClaw project
  checks.nanoclawProject = fs.existsSync(path.join(PROJECT_DIR, 'package.json'));
  checks.nanoclawBuilt = fs.existsSync(path.join(PROJECT_DIR, 'dist', 'index.js'));
  // NanoClaw WhatsApp auth
  checks.nanoclawWhatsAppAuth = fs.existsSync(path.join(PROJECT_DIR, 'store', 'auth', 'creds.json'));
  // Ollama
  try {
    const result = execSync('curl -sf -m 2 http://127.0.0.1:11434/api/tags', { encoding: 'utf-8', timeout: 3000 });
    checks.ollamaRunning = true;
  } catch { checks.ollamaRunning = false; }

  return checks;
});

// ---- Set project directory ----
ipcMain.handle('oc:set-project-dir', async (_, dir) => {
  if (dir && fs.existsSync(path.join(dir, 'package.json'))) {
    saveProjectDir(dir);
    return { ok: true, projectDir: dir };
  }
  return { ok: false, error: 'Invalid directory — no package.json found' };
});

// ---- NanoClaw service management ----
const PID_FILE = path.join(HOME, '.config', 'nanoclaw', 'service.pid');

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    if (pid && !isNaN(pid)) {
      // Check if process is alive
      try { process.kill(pid, 0); return pid; } catch { /* dead */ }
    }
  } catch {}
  return null;
}

function writePid(pid) {
  const dir = path.dirname(PID_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function isNCRunning() {
  // Check PID file first
  if (readPid()) return true;
  // Fallback: pgrep
  try {
    const ps = execSync(`pgrep -f "node.*dist/index.js"`, { encoding: 'utf-8', timeout: 3000 });
    return ps.trim().length > 0;
  } catch { return false; }
}

ipcMain.handle('nc:start', async () => {
  if (isNCRunning()) return { ok: true, already: true, pid: readPid(), projectDir: PROJECT_DIR };

  // Ensure built
  const distIndex = path.join(PROJECT_DIR, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    return { ok: false, error: `dist/index.js not found at ${PROJECT_DIR}. Run Build first.` };
  }

  const logDir = path.join(PROJECT_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'nanoclaw.log');

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  const child = spawn('node', [distIndex], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, NODE_ENV: 'production' },
  });

  child.unref();
  writePid(child.pid);

  // Wait a moment and verify it's running
  await new Promise(r => setTimeout(r, 2000));
  const alive = isNCRunning();
  return { ok: alive, pid: child.pid, projectDir: PROJECT_DIR };
});

ipcMain.handle('nc:stop', async () => {
  const pid = readPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    clearPid();
    // Give it a second to die
    await new Promise(r => setTimeout(r, 1000));
    // Force kill if still alive
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
  }
  // Also kill any strays
  try { execSync(`pkill -f "node.*dist/index.js"`, { timeout: 3000 }); } catch {}
  clearPid();
  return { ok: true };
});

ipcMain.handle('nc:status', async () => {
  const pid = readPid();
  const running = isNCRunning();
  return { running, pid, projectDir: PROJECT_DIR };
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
// Spawns the auth script, polls store/qr-data.txt, sends QR SVG to renderer
ipcMain.handle('nc:whatsapp-auth', async () => {
  const storeDir = path.join(PROJECT_DIR, 'store');
  const authDir = path.join(storeDir, 'auth');
  const qrFile = path.join(storeDir, 'qr-data.txt');
  const statusFile = path.join(storeDir, 'auth-status.txt');

  // Clean stale state
  try { fs.unlinkSync(qrFile); } catch {}
  try { fs.unlinkSync(statusFile); } catch {}
  fs.mkdirSync(authDir, { recursive: true });

  // Spawn the raw auth script (NOT the setup wrapper — it tries to open a browser)
  const proc = spawn('npx', ['tsx', 'src/whatsapp-auth.ts'], {
    cwd: PROJECT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });

  // Poll for QR data file and auth status
  let resolved = false;
  const pollInterval = setInterval(async () => {
    // Check if QR data is available
    try {
      if (fs.existsSync(qrFile)) {
        const qrData = fs.readFileSync(qrFile, 'utf-8').trim();
        if (qrData) {
          // Generate SVG from QR data using the qrcode library
          try {
            const svg = execSync(
              `node -e "const QR=require('qrcode');QR.toString('${qrData}',{type:'svg'},(e,s)=>{if(!e)process.stdout.write(s)})"`,
              { cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 5000 }
            );
            mainWindow?.webContents.send('whatsapp:qr', { svg, raw: qrData });
          } catch {
            // Fallback: send raw data, renderer can display as text
            mainWindow?.webContents.send('whatsapp:qr', { raw: qrData });
          }
        }
      }
    } catch {}

    // Check auth status
    try {
      if (fs.existsSync(statusFile)) {
        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status === 'authenticated' || status === 'already_authenticated') {
          clearInterval(pollInterval);
          if (!resolved) {
            resolved = true;
            mainWindow?.webContents.send('whatsapp:ready', {});
          }
        } else if (status.startsWith('failed:')) {
          clearInterval(pollInterval);
          if (!resolved) {
            resolved = true;
            mainWindow?.webContents.send('whatsapp:failed', { reason: status });
          }
        }
      }
    } catch {}
  }, 1500);

  return new Promise((resolve) => {
    proc.on('close', (code) => {
      clearInterval(pollInterval);
      resolved = true;
      resolve({ ok: code === 0, output });
    });
    proc.on('error', (err) => {
      clearInterval(pollInterval);
      resolved = true;
      resolve({ ok: false, error: err.message });
    });
    // Timeout after 2 minutes
    setTimeout(() => {
      clearInterval(pollInterval);
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch {}
        resolve({ ok: false, error: 'timeout' });
      }
    }, 120000);
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

// ===========================================================================
// OLLAMA INTEGRATION
// ===========================================================================

ipcMain.handle('ollama:status', async () => {
  try {
    const result = await runCmd('curl -sf -m 3 http://127.0.0.1:11434/api/tags', { timeout: 5000 });
    if (result.ok && result.stdout) {
      const data = JSON.parse(result.stdout);
      return { running: true, models: data.models || [] };
    }
    return { running: false, models: [] };
  } catch { return { running: false, models: [] }; }
});

ipcMain.handle('ollama:chat', async (_, { model, message }) => {
  // Send a chat message to Ollama
  const payload = JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: false });
  const escaped = payload.replace(/'/g, "'\\''");
  const result = await runCmd(
    `curl -sf -m 120 http://127.0.0.1:11434/api/chat -d '${escaped}'`,
    { timeout: 130000 }
  );
  if (result.ok && result.stdout) {
    try {
      const data = JSON.parse(result.stdout);
      return { ok: true, response: data.message?.content || '' };
    } catch { return { ok: false, error: 'Invalid response' }; }
  }
  return { ok: false, error: result.error || 'Ollama not responding' };
});

ipcMain.handle('ollama:generate', async (_, { model, prompt }) => {
  const payload = JSON.stringify({ model, prompt, stream: false });
  const escaped = payload.replace(/'/g, "'\\''");
  const result = await runCmd(
    `curl -sf -m 120 http://127.0.0.1:11434/api/generate -d '${escaped}'`,
    { timeout: 130000 }
  );
  if (result.ok && result.stdout) {
    try {
      const data = JSON.parse(result.stdout);
      return { ok: true, response: data.response || '' };
    } catch { return { ok: false, error: 'Invalid response' }; }
  }
  return { ok: false, error: result.error || 'Ollama not responding' };
});

// Configure NanoClaw to use Ollama as the backend
ipcMain.handle('ollama:configure', async (_, { model, baseUrl }) => {
  baseUrl = baseUrl || 'http://127.0.0.1:11434';
  model = model || 'qwen2.5:latest';

  // Update .env to point to Ollama
  const envFile = path.join(PROJECT_DIR, '.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envFile, 'utf-8'); } catch {}

  // Parse existing env
  const env = {};
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }

  // Set Ollama config — NanoClaw's credential proxy forwards to ANTHROPIC_BASE_URL
  // For Ollama, we use its OpenAI-compatible endpoint
  env['OLLAMA_BASE_URL'] = baseUrl;
  env['OLLAMA_MODEL'] = model;

  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });

  // Sync to container env
  const envDir = path.join(PROJECT_DIR, 'data', 'env');
  fs.mkdirSync(envDir, { recursive: true });
  fs.copyFileSync(envFile, path.join(envDir, 'env'));

  // Also update OpenClaw config to reference the Ollama model
  const config = readConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  // Store ollama model info
  if (!config.agents.defaults.ollama) config.agents.defaults.ollama = {};
  config.agents.defaults.ollama.model = model;
  config.agents.defaults.ollama.baseUrl = baseUrl;
  writeConfig(config);

  return { ok: true, model, baseUrl };
});
