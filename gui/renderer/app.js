// ============================================================
// NanoClaw Manager — Application Logic
// All operations via GUI — no CLI needed
// ============================================================

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}

// ---- Navigation ----
const App = {
  currentPage: 'dashboard',
  navigate(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    const navEl = document.querySelector(`[data-page="${page}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');
    this.currentPage = page;
    this.onPageEnter(page);
  },
  onPageEnter(page) {
    switch (page) {
      case 'dashboard': Dashboard.refresh(); break;
      case 'channels': Channels.refresh(); break;
      case 'groups': Groups.refresh(); break;
      case 'automations': Automations.refresh(); break;
      case 'ollama': Ollama.refresh(); break;
      case 'settings': Settings.load(); break;
      case 'logs': Logs.refresh(); break;
    }
  }
};

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => { e.preventDefault(); App.navigate(item.dataset.page); });
});

// ============================================================
// DASHBOARD
// ============================================================
const Dashboard = {
  ncRunning: false,

  async refresh() {
    try {
      const [ncStatus, deps, groups, stats] = await Promise.allSettled([
        window.oc.ncStatus(),
        window.oc.checkDeps(),
        window.oc.ncGroups(),
        window.oc.ncMessageStats(),
      ]);

      const nc = ncStatus.status === 'fulfilled' ? ncStatus.value : {};
      this.ncRunning = nc.running || false;
      const d = deps.status === 'fulfilled' ? deps.value : {};
      const g = groups.status === 'fulfilled' ? groups.value : {};
      const m = stats.status === 'fulfilled' ? stats.value : {};

      // Update version info with project dir
      document.getElementById('version-info').textContent = d.projectDir
        ? 'Project: ' + d.projectDir.split('/').pop()
        : 'NanoClaw';

      // Service status
      const dot = document.getElementById('status-dot');
      const label = document.getElementById('status-label');
      const btn = document.getElementById('btn-nc-toggle');
      if (this.ncRunning) {
        dot.className = 'status-dot green'; label.textContent = 'Running';
        document.getElementById('stat-service').textContent = 'Online';
        document.getElementById('stat-service-sub').textContent = nc.pid ? `PID ${nc.pid}` : 'Service active';
        btn.textContent = 'Stop'; btn.className = 'btn btn-danger btn-sm';
      } else {
        dot.className = 'status-dot gray'; label.textContent = 'Stopped';
        document.getElementById('stat-service').textContent = 'Offline';
        document.getElementById('stat-service-sub').textContent = d.nanoclawBuilt ? 'Ready to start' : 'Not built';
        btn.textContent = 'Start'; btn.className = 'btn btn-success btn-sm';
      }

      // Channels count
      let chCount = 0;
      if (d.telegramConfigured) chCount++;
      if (d.nanoclawWhatsAppAuth || d.whatsappAuth) chCount++;
      document.getElementById('stat-channels').textContent = chCount;

      // Groups
      const groupCount = Object.keys(g).length;
      document.getElementById('stat-groups').textContent = groupCount;

      // Messages
      document.getElementById('stat-messages').textContent = m.total || 0;
      document.getElementById('stat-messages-sub').textContent = m.today ? `${m.today} today` : 'total';

      // Channels card
      this.renderChannels(d);
      // Groups card
      this.renderGroups(g);

    } catch (err) { console.error('Dashboard error:', err); }
  },

  renderChannels(deps) {
    const el = document.getElementById('dash-channels');
    let html = '';
    if (deps.telegramConfigured) {
      html += `<div class="list-row"><div class="list-row-info"><div class="list-row-title"><span class="channel-badge telegram" style="margin-right:6px">T</span>Telegram</div><div class="list-row-detail">Bot configured</div></div><span class="badge badge-success">Active</span></div>`;
    }
    if (deps.nanoclawWhatsAppAuth || deps.whatsappAuth) {
      html += `<div class="list-row"><div class="list-row-info"><div class="list-row-title"><span class="channel-badge whatsapp" style="margin-right:6px">W</span>WhatsApp</div><div class="list-row-detail">Linked device</div></div><span class="badge badge-success">Active</span></div>`;
    }
    if (!html) html = '<div class="empty-state"><p>No channels configured yet</p><p class="text-secondary">Go to Channels to set up Telegram or WhatsApp</p></div>';
    el.innerHTML = html;
  },

  renderGroups(groups) {
    const el = document.getElementById('dash-groups');
    const entries = Object.entries(groups);
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state"><p>No groups registered</p></div>';
      return;
    }
    let html = '';
    for (const [jid, g] of entries.slice(0, 6)) {
      const ch = jid.startsWith('tg:') ? 'Telegram' : 'WhatsApp';
      html += `<div class="list-row"><div class="list-row-info"><div class="list-row-title">${esc(g.name || jid)}</div><div class="list-row-detail">${ch} &middot; ${esc(g.folder || '')}</div></div>${g.isMain ? '<span class="badge badge-success">Main</span>' : '<span class="badge">Group</span>'}</div>`;
    }
    el.innerHTML = html;
  },

  async toggleNC() {
    const btn = document.getElementById('btn-nc-toggle');
    btn.disabled = true;
    btn.textContent = this.ncRunning ? 'Stopping...' : 'Starting...';
    try {
      if (this.ncRunning) {
        await window.oc.ncStop();
        toast('Service stopped', 'info');
      } else {
        const result = await window.oc.ncStart();
        if (result.ok) {
          toast(result.already ? 'Already running' : `Service started (PID ${result.pid})`, 'success');
        } else {
          toast('Failed: ' + (result.error || 'unknown error'), 'error');
        }
      }
    } catch (err) { toast('Error: ' + err.message, 'error'); }
    btn.disabled = false;
    setTimeout(() => this.refresh(), 1500);
  }
};

// ============================================================
// CHANNELS
// ============================================================
const Channels = {
  async refresh() {
    const deps = await window.oc.checkDeps();
    const config = await window.oc.configRead();

    // Telegram
    const tgToken = config?.channels?.telegram?.botToken || '';
    const tgBadge = document.getElementById('tg-badge');
    if (tgToken || deps.telegramConfigured) {
      tgBadge.textContent = 'Connected';
      tgBadge.className = 'badge badge-success';
      document.getElementById('tg-token').value = tgToken;
      document.getElementById('tg-status').innerHTML = '<p class="text-secondary mt-4">Telegram bot is configured and active.</p>';
    } else {
      tgBadge.textContent = 'Not configured';
      tgBadge.className = 'badge';
      document.getElementById('tg-status').innerHTML = '';
    }

    // WhatsApp
    const waBadge = document.getElementById('wa-badge');
    if (deps.nanoclawWhatsAppAuth || deps.whatsappAuth) {
      waBadge.textContent = 'Connected';
      waBadge.className = 'badge badge-success';
      document.getElementById('btn-wa-qr').textContent = 'Re-authenticate';
      document.getElementById('btn-wa-remove').style.display = '';
      document.getElementById('wa-status').innerHTML = '<p class="text-secondary mt-4">WhatsApp is linked and authenticated.</p>';
    } else {
      waBadge.textContent = 'Not configured';
      waBadge.className = 'badge';
      document.getElementById('btn-wa-remove').style.display = 'none';
      document.getElementById('wa-status').innerHTML = '';
    }
  },

  async saveTelegram() {
    const token = document.getElementById('tg-token').value.trim();
    if (!token) { toast('Enter a bot token', 'error'); return; }

    const btn = document.getElementById('btn-tg-save');
    btn.disabled = true; btn.textContent = 'Saving...';

    try {
      // Save to OpenClaw config
      await window.oc.channelAddTelegram(token, 'main');
      // Also save to NanoClaw .env
      const env = await window.oc.ncReadEnv();
      env.TELEGRAM_BOT_TOKEN = token;
      await window.oc.ncWriteEnv(env);
      toast('Telegram connected', 'success');
      this.refresh();
    } catch (err) { toast('Error: ' + err.message, 'error'); }

    btn.disabled = false; btn.textContent = 'Save & Connect';
  },

  async startWhatsAppQR() {
    const container = document.getElementById('wa-qr-container');
    const qrEl = document.getElementById('wa-qr-code');
    const statusEl = document.getElementById('wa-qr-status');
    container.classList.remove('hidden');
    statusEl.innerHTML = '<div class="spinner"></div> Starting authentication... this may take a few seconds';
    qrEl.innerHTML = '';

    // Clean up old listeners
    window.oc.offWhatsAppQR();
    window.oc.offWhatsAppReady();
    window.oc.offWhatsAppFailed();

    // Listen for QR SVG from main process (polled from store/qr-data.txt)
    window.oc.onWhatsAppQR((data) => {
      if (data.svg) {
        qrEl.innerHTML = data.svg;
        // Scale SVG nicely
        const svg = qrEl.querySelector('svg');
        if (svg) { svg.style.width = '260px'; svg.style.height = '260px'; }
      } else if (data.raw) {
        qrEl.textContent = data.raw;
      }
      statusEl.innerHTML = '<p class="text-secondary">Open WhatsApp > Settings > Linked Devices > Link a Device<br>Then scan this QR code</p>';
    });

    window.oc.onWhatsAppReady(() => {
      statusEl.innerHTML = '<p style="color:var(--success);font-weight:600;font-size:16px">Authenticated successfully!</p>';
      toast('WhatsApp connected', 'success');
      setTimeout(() => { container.classList.add('hidden'); this.refresh(); }, 2500);
    });

    window.oc.onWhatsAppFailed((data) => {
      statusEl.innerHTML = `<p style="color:var(--error)">Authentication failed: ${esc(data.reason || 'unknown')}</p>`;
      toast('WhatsApp auth failed', 'error');
    });

    // Start auth — main process polls QR file and sends events
    try {
      const result = await window.oc.ncWhatsAppAuth();
      if (result.ok) {
        toast('WhatsApp authenticated', 'success');
        this.refresh();
      } else if (result.error) {
        statusEl.innerHTML = `<p style="color:var(--error)">${esc(result.error)}</p>`;
      }
    } catch (err) {
      statusEl.innerHTML = `<p style="color:var(--error)">Error: ${esc(err.message)}</p>`;
    }
  },

  async removeWhatsApp() {
    if (!confirm('Disconnect WhatsApp?')) return;
    await window.oc.channelRemove('whatsapp', 'main');
    toast('WhatsApp disconnected', 'info');
    this.refresh();
  }
};

// ============================================================
// GROUPS
// ============================================================
const Groups = {
  async refresh() {
    const groups = await window.oc.ncGroups();
    const el = document.getElementById('groups-list');
    const entries = Object.entries(groups);
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state"><span class="empty-icon">&#9783;</span><p>No groups registered</p><p class="text-secondary">Click "Add Group" to register a chat</p></div>';
      return;
    }
    let html = '';
    for (const [jid, g] of entries) {
      const ch = jid.startsWith('tg:') ? 'Telegram' : jid.includes('@g.us') ? 'WhatsApp Group' : 'WhatsApp DM';
      html += `<div class="list-row">
        <div class="list-row-info">
          <div class="list-row-title">${esc(g.name || 'Unnamed')}</div>
          <div class="list-row-detail list-row-mono">${esc(jid)} &middot; ${ch} &middot; ${esc(g.folder || '')}</div>
        </div>
        <div class="list-row-actions">
          ${g.isMain ? '<span class="badge badge-success">Main</span>' : ''}
          ${g.requiresTrigger === false ? '<span class="badge">No trigger</span>' : ''}
        </div>
      </div>`;
    }
    el.innerHTML = html;
  },

  showAddModal() {
    document.getElementById('add-group-card').classList.remove('hidden');
    // Pre-fill trigger from env
    window.oc.ncReadEnv().then(env => {
      document.getElementById('grp-trigger').value = '@' + (env.ASSISTANT_NAME || 'Andy');
    });
  },

  hideAddModal() { document.getElementById('add-group-card').classList.add('hidden'); },

  async registerGroup() {
    const jid = document.getElementById('grp-jid').value.trim();
    const name = document.getElementById('grp-name').value.trim();
    const folder = document.getElementById('grp-folder').value.trim();
    const channel = document.getElementById('grp-channel').value;
    const trigger = document.getElementById('grp-trigger').value.trim();
    const isMain = document.getElementById('grp-is-main').checked;

    if (!jid || !name || !folder) { toast('Fill in JID, name, and folder', 'error'); return; }

    const env = await window.oc.ncReadEnv();
    const result = await window.oc.ncRegisterGroup({
      jid, name, folder, channel, trigger, isMain,
      assistantName: env.ASSISTANT_NAME || 'Andy'
    });

    if (result.ok) {
      toast('Group registered', 'success');
      this.hideAddModal();
      this.refresh();
    } else {
      toast('Error: ' + (result.error || result.stderr || 'Registration failed'), 'error');
    }
  }
};

// ============================================================
// AUTOMATIONS
// ============================================================
const Automations = {
  async refresh() {
    // Cron jobs
    const jobs = await window.oc.cronList();
    const el = document.getElementById('cron-list');
    if (!jobs || !jobs.length) {
      el.innerHTML = '<div class="empty-state"><span class="empty-icon">&#9889;</span><p>No cron jobs</p></div>';
    } else {
      let html = '';
      for (const job of jobs) {
        html += `<div class="list-row">
          <div class="list-row-info">
            <div class="list-row-title">${esc(job.name)}</div>
            <div class="list-row-detail list-row-mono">${esc(job.schedule)} &middot; ${esc(job.prompt || '').slice(0, 80)}</div>
          </div>
          <div class="list-row-actions">
            <label class="toggle-switch"><input type="checkbox" ${job.enabled ? 'checked' : ''} onchange="Automations.toggleJob('${esc(job.name)}', this.checked)"><span class="toggle-slider"></span></label>
            <button class="btn btn-sm btn-secondary" onclick="Automations.runJob('${esc(job.name)}')">Run</button>
            <button class="btn btn-sm btn-danger" onclick="Automations.removeJob('${esc(job.name)}')">Remove</button>
          </div>
        </div>`;
      }
      el.innerHTML = html;
    }

    // Scheduled tasks from DB
    const tasks = await window.oc.ncTasks();
    const tel = document.getElementById('tasks-list');
    if (!tasks || !tasks.length) {
      tel.innerHTML = '<div class="empty-state"><p>No tasks scheduled by the assistant yet</p></div>';
    } else {
      let html = '';
      for (const t of tasks) {
        html += `<div class="list-row">
          <div class="list-row-info">
            <div class="list-row-title">${esc(t.prompt || '').slice(0, 100)}</div>
            <div class="list-row-detail list-row-mono">${esc(t.schedule_type)}: ${esc(t.schedule_value)} &middot; ${esc(t.status)} &middot; next: ${esc(t.next_run || '--')}</div>
          </div>
          <span class="badge ${t.status === 'active' ? 'badge-success' : ''}">${esc(t.status)}</span>
        </div>`;
      }
      tel.innerHTML = html;
    }
  },

  showAddModal() { document.getElementById('add-cron-card').classList.remove('hidden'); },
  hideAddModal() { document.getElementById('add-cron-card').classList.add('hidden'); },

  async addJob() {
    const name = document.getElementById('cron-name').value.trim();
    const schedule = document.getElementById('cron-schedule').value.trim();
    const prompt = document.getElementById('cron-prompt').value.trim();
    const channel = document.getElementById('cron-channel').value;
    const target = document.getElementById('cron-target').value.trim();
    if (!name || !schedule || !prompt) { toast('Fill in all required fields', 'error'); return; }
    try {
      await window.oc.cronAdd({ name, schedule, prompt, channel, target });
      toast('Job created', 'success');
      this.hideAddModal();
      this.refresh();
    } catch (err) { toast('Failed to create job: ' + err.message, 'error'); }
  },

  async toggleJob(name, enabled) {
    try {
      await window.oc.cronToggle(name, enabled);
      toast(enabled ? 'Job enabled' : 'Job disabled', 'info');
    } catch (err) { toast('Toggle failed: ' + err.message, 'error'); }
  },

  async runJob(name) {
    try {
      toast('Running job...', 'info');
      const result = await window.oc.cronRun(name);
      if (result.ok) toast('Job ran successfully', 'success');
      else toast('Job failed', 'error');
    } catch (err) { toast('Run failed: ' + err.message, 'error'); }
  },

  async removeJob(name) {
    if (!confirm(`Delete job "${name}"?`)) return;
    try {
      await window.oc.cronRemove(name);
      toast('Job removed', 'info');
      this.refresh();
    } catch (err) { toast('Remove failed: ' + err.message, 'error'); }
  }
};

// ============================================================
// SETTINGS
// ============================================================
const Settings = {
  async load() {
    const [env, config, deps, paths] = await Promise.all([
      window.oc.ncReadEnv(),
      window.oc.configRead(),
      window.oc.checkDeps(),
      window.oc.getPaths(),
    ]);

    // Assistant
    document.getElementById('cfg-name').value = env.ASSISTANT_NAME || 'Andy';
    const model = config?.agents?.defaults?.model || 'anthropic/claude-sonnet-4-6';
    document.getElementById('cfg-model').value = model;

    // API keys from store
    const storeData = await window.oc.storeGetAll();
    document.getElementById('cfg-anthropic-key').value = env.ANTHROPIC_API_KEY || storeData.key_anthropic || '';
    document.getElementById('cfg-openai-key').value = storeData.api_key || '';

    // Service info
    const ncStatus = await window.oc.ncStatus();
    document.getElementById('nc-service-info').textContent = ncStatus.running ? 'Running' : 'Stopped';

    const gwHealth = await window.oc.gatewayHealth();
    document.getElementById('oc-gw-info').textContent = gwHealth.running ? `Running on port ${gwHealth.port}` : 'Stopped';

    // Paths
    document.getElementById('path-project').textContent = paths.projectDir || '--';
    document.getElementById('path-oc').textContent = paths.ocDir || '--';
  },

  async save() {
    try {
      const env = await window.oc.ncReadEnv();
      const name = document.getElementById('cfg-name').value.trim();
      if (name) env.ASSISTANT_NAME = name;
      const apiKey = document.getElementById('cfg-anthropic-key').value.trim();
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      await window.oc.ncWriteEnv(env);

      const model = document.getElementById('cfg-model').value;
      await window.oc.configPatch({ agents: { defaults: { model } } });

      if (apiKey) await window.oc.storeSet('key_anthropic', apiKey);
      const openaiKey = document.getElementById('cfg-openai-key').value.trim();
      if (openaiKey) await window.oc.storeSet('api_key', openaiKey);

      toast('Settings saved', 'success');
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  },

  async buildNC() {
    try {
      toast('Building NanoClaw...', 'info');
      const result = await window.oc.ncBuild();
      if (result.ok) toast('Build successful', 'success');
      else toast('Build failed: ' + (result.stderr || result.error || '').slice(0, 100), 'error');
    } catch (err) { toast('Build error: ' + err.message, 'error'); }
  },

  async restartNC() {
    try {
      await window.oc.ncStop();
      await new Promise(r => setTimeout(r, 1000));
      const result = await window.oc.ncStart();
      if (result.ok) toast('Service restarted', 'success');
      else toast('Restart failed: ' + (result.error || ''), 'error');
      setTimeout(() => Dashboard.refresh(), 1500);
    } catch (err) { toast('Restart error: ' + err.message, 'error'); }
  },

  async startGW() {
    try {
      toast('Starting gateway...', 'info');
      const result = await window.oc.gatewayStart();
      if (result.ok) toast('Gateway started', 'success');
      else toast('Failed to start gateway', 'error');
      this.load();
    } catch (err) { toast('Gateway error: ' + err.message, 'error'); }
  },

  async stopGW() {
    try {
      await window.oc.gatewayStop();
      toast('Gateway stopped', 'info');
      this.load();
    } catch (err) { toast('Gateway error: ' + err.message, 'error'); }
  },

  async openProject() { const p = await window.oc.getPaths(); window.oc.openFolder(p.projectDir); },
  async openOC() { const p = await window.oc.getPaths(); window.oc.openFolder(p.ocDir); },

  async changeProjectDir() {
    const dir = await window.oc.selectFolder();
    if (!dir) return;
    const result = await window.oc.setProjectDir(dir);
    if (result.ok) {
      toast('Project directory set to: ' + dir, 'success');
      this.load();
    } else {
      toast(result.error || 'Invalid directory', 'error');
    }
  },

  async runDoctor() {
    const out = document.getElementById('doctor-output');
    out.classList.remove('hidden');
    out.querySelector('pre').textContent = 'Running diagnostics...';
    const result = await window.oc.doctor();
    out.querySelector('pre').textContent = result || 'No output';
  }
};

// ============================================================
// LOGS
// ============================================================
const Logs = {
  async refresh() {
    try {
      const content = await window.oc.logs(300);
      document.getElementById('log-content').textContent = content || 'No logs available';
      const viewer = document.getElementById('log-viewer');
      viewer.scrollTop = viewer.scrollHeight;
    } catch (err) {
      document.getElementById('log-content').textContent = 'Failed to load logs: ' + err.message;
    }
  },

  async showErrors() {
    try {
      const errors = await window.oc.logsError();
      if (errors) {
        document.getElementById('log-content').textContent = '=== ERROR LOG ===\n\n' + errors;
      } else {
        toast('No error logs found', 'info');
      }
    } catch (err) { toast('Failed to load errors: ' + err.message, 'error'); }
  }
};

// ============================================================
// OLLAMA
// ============================================================
const Ollama = {
  currentModels: [],

  async refresh() {
    const status = await window.oc.ollamaStatus();
    const badge = document.getElementById('ollama-badge');
    const modelsEl = document.getElementById('ollama-models');
    const selectEl = document.getElementById('ollama-model');

    if (status.running) {
      badge.textContent = 'Running';
      badge.className = 'badge badge-success';
      this.currentModels = status.models || [];

      if (this.currentModels.length) {
        let html = '';
        for (const m of this.currentModels) {
          const sizeGB = (m.size / 1e9).toFixed(1);
          const params = m.details?.parameter_size || '';
          html += `<div class="list-row">
            <div class="list-row-info">
              <div class="list-row-title">${esc(m.name)}</div>
              <div class="list-row-detail">${sizeGB} GB &middot; ${esc(params)} &middot; ${esc(m.details?.quantization_level || '')}</div>
            </div>
            <span class="badge badge-success">Available</span>
          </div>`;
        }
        modelsEl.innerHTML = html;

        // Update select options
        selectEl.innerHTML = '';
        for (const m of this.currentModels) {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = `${m.name} (${m.details?.parameter_size || ''})`;
          selectEl.appendChild(opt);
        }
      } else {
        modelsEl.innerHTML = '<div class="empty-state"><p>No models found. Pull a model with: ollama pull qwen2.5</p></div>';
      }
    } else {
      badge.textContent = 'Offline';
      badge.className = 'badge badge-error';
      modelsEl.innerHTML = '<div class="empty-state"><p>Ollama is not running</p><p class="text-secondary">Start it with: brew services start ollama</p></div>';
    }
  },

  async configure() {
    try {
      const model = document.getElementById('ollama-model').value;
      const url = document.getElementById('ollama-url').value.trim();
      const result = await window.oc.ollamaConfigure(model, url);
      if (result.ok) toast(`Ollama configured: ${model}`, 'success');
      else toast('Failed to configure Ollama', 'error');
    } catch (err) { toast('Configure error: ' + err.message, 'error'); }
  },

  async testChat() {
    const input = document.getElementById('ollama-test-input').value.trim();
    if (!input) { toast('Enter a message', 'error'); return; }

    const model = document.getElementById('ollama-model').value;
    const outEl = document.getElementById('ollama-test-output');
    outEl.classList.remove('hidden');
    outEl.querySelector('pre').textContent = `Sending to ${model}...`;

    try {
      const result = await window.oc.ollamaChat(model, input);
      if (result.ok) outEl.querySelector('pre').textContent = result.response;
      else outEl.querySelector('pre').textContent = 'Error: ' + (result.error || 'no response');
    } catch (err) {
      outEl.querySelector('pre').textContent = 'Error: ' + err.message;
    }
  }
};

// ============================================================
// INIT
// ============================================================
(async function init() {
  await Dashboard.refresh();
  // Auto-refresh dashboard every 10s
  setInterval(() => { if (App.currentPage === 'dashboard') Dashboard.refresh(); }, 10000);
})();
