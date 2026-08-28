import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ProviderId, TerminalEvent, TerminalInfo } from '@shared/types';
import { PROVIDER_CLI, PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models';
import { clear, h, icon } from '../lib/dom';
import { api, state, toast, update } from '../state';

/**
 * The agent view: real terminals running `claude` and `codex`.
 *
 * The chat view talks to models; this talks to the agents. It matters because
 * the CLIs are where tool use, file edits, and permission prompts live — a
 * chat-only wrapper cannot drive those. Each tab owns one xterm instance and
 * one process in the main process, keyed by the same id.
 */

interface Tab {
  info: TerminalInfo;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLElement;
  exited: boolean;
}

const tabs = new Map<string, Tab>();
let activeId: string | null = null;
let tabsBar: HTMLElement | null = null;
let host: HTMLElement | null = null;
let banner: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

export function renderAgents(container: HTMLElement): void {
  clear(container);
  container.classList.add('agent-view');

  tabsBar = h('div', { class: 'tabs' });
  banner = h('div', { class: 'terminal-banner' });
  host = h('div', { class: 'terminal-host' });

  container.appendChild(tabsBar);
  container.appendChild(banner);
  container.appendChild(host);

  // Panes are re-parented on every render, so re-attach the existing ones
  // instead of losing running sessions when the user switches views.
  for (const tab of tabs.values()) host.appendChild(tab.pane);

  paintTabs();
  paintBanner();

  if (tabs.size === 0) {
    host.appendChild(emptyState());
  } else if (activeId) {
    activate(activeId);
  }

  // Subscribed once and kept across view changes. The main process forwards
  // pty output with no buffering and keeps no scrollback, so anything a CLI
  // wrote while the user was in Chat or Settings was gone for good — and a
  // missed `exit` left the tab showing a green dot over a session that had
  // already been reaped, silently swallowing every keystroke.
  unsubscribe ??= api.terminal.onEvent(handleTerminalEvent);

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => fitActive());
  resizeObserver.observe(host);
}

export function buildAgentToolbar(): HTMLElement[] {
  const workspace = state.settings.workspaceDir;

  const providerSelect = h(
    'select',
    { class: 'inline', id: 'agent-provider', title: 'Which agent CLI to launch' },
    ...PROVIDER_ORDER.map((id) =>
      h('option', {
        value: id,
        text: PROVIDER_CLI[id].label,
        attrs: { selected: id === state.settings.defaultProvider },
      }),
    ),
  );

  const cwdButton = h(
    'button',
    {
      class: 'btn ghost',
      title: `Working directory: ${workspace}`,
      on: {
        click: async () => {
          const picked = await api.app.pickDirectory(state.settings.workspaceDir);
          if (!picked) return;
          await api.settings.set({ workspaceDir: picked });
          update({ settings: await api.settings.get() });
        },
      },
    },
    icon('folder', 15),
    h('span', { text: shortenPath(workspace) }),
  );

  const newButton = h(
    'button',
    {
      class: 'btn primary',
      on: {
        click: () => {
          const provider = (document.getElementById('agent-provider') as HTMLSelectElement)
            .value as ProviderId;
          void openTerminal(provider);
        },
      },
    },
    icon('plus', 15),
    'New session',
  );

  return [providerSelect, cwdButton, newButton];
}

function emptyState(): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      {},
      icon('terminal', 34),
      h('h2', { text: 'Run a coding agent' }),
      h('p', {
        text:
          'Start Claude Code or Codex in a real terminal, inside the working directory you choose. ' +
          'Selecting GLM points Claude Code at Z.ai, so the same agent runs on GLM models.',
      }),
      h(
        'div',
        { class: 'row', style: { justifyContent: 'center' } },
        ...PROVIDER_ORDER.map((id) =>
          h(
            'button',
            { class: 'btn', on: { click: () => void openTerminal(id) } },
            h('span', { class: `provider-badge ${id}`, text: initials(id) }),
            PROVIDER_CLI[id].label,
          ),
        ),
      ),
    ),
  );
}

function initials(provider: ProviderId): string {
  return { glm: 'GLM', anthropic: 'CC', openai: 'CX', kimi: 'KM' }[provider];
}

/* ---------------------------------------------------------------- tabs --- */

function paintTabs(): void {
  if (!tabsBar) return;
  clear(tabsBar);

  for (const tab of tabs.values()) {
    const label = `${PROVIDER_CLI[tab.info.spec.provider].label}${tab.exited ? ' (exited)' : ''}`;
    const button = h(
      'button',
      {
        class: 'tab',
        attrs: { 'aria-selected': String(tab.info.id === activeId) },
        title: `${tab.info.commandLine}\n${tab.info.spec.cwd}`,
        on: { click: () => activate(tab.info.id) },
      },
      h('span', { class: `dot ${tab.exited ? 'off' : 'ok'}` }),
      h('span', { text: label }),
      h('span', {
        class: 'tab-close',
        text: '×',
        attrs: { role: 'button', 'aria-label': 'Close session' },
        on: {
          click: (event) => {
            event.stopPropagation();
            void closeTab(tab.info.id);
          },
        },
      }),
    );
    tabsBar.appendChild(button);
  }
}

function paintBanner(): void {
  if (!banner) return;
  clear(banner);
  const tab = activeId ? tabs.get(activeId) : null;
  if (!tab) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = '';
  banner.appendChild(h('span', { text: tab.info.spec.cwd }));
  banner.appendChild(h('span', { text: tab.info.commandLine }));
  if (!tab.info.pty) {
    banner.appendChild(
      h('span', {
        class: 'warn',
        text: 'pipe mode — interactive prompts will not render',
        title: 'Rebuild the terminal backend: npm rebuild node-pty',
      }),
    );
  }
}

/** Builds a configured xterm instance and mounts it into a fresh pane. */
function mountTerminal(): { term: Terminal; fit: FitAddon; pane: HTMLElement } {
  const term = new Terminal({
    fontFamily:
      'ui-monospace, "JetBrains Mono", "Fira Code", "Cascadia Code", "Ubuntu Mono", monospace',
    fontSize: Math.max(11, state.settings.fontSize - 1),
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => void api.app.openExternal(uri)));

  const pane = h('div', { class: 'terminal-pane' });
  host!.appendChild(pane);
  term.open(pane);
  try {
    fit.fit();
  } catch {
    // The host can still be zero-sized on the first frame after a view switch.
  }
  return { term, fit, pane };
}

async function openTerminal(provider: ProviderId): Promise<void> {
  if (!host) return;

  // The empty state occupies the host until the first tab exists.
  host.querySelector('.empty')?.remove();

  let info: TerminalInfo;
  try {
    // Spawn before building the terminal: a missing CLI is the common failure,
    // and an empty xterm behind an error message reads like a broken app.
    info = await api.terminal.start({
      provider,
      kind: 'agent',
      cwd: state.settings.workspaceDir,
      cols: 100,
      rows: 30,
    });
  } catch (err) {
    host.appendChild(failurePanel(cliErrorMessage(err)));
    return;
  }

  attachTerminal(info);
}

/** Wires a started session to a new xterm and makes it the active tab. */
function attachTerminal(info: TerminalInfo): void {
  const { term, fit, pane } = mountTerminal();
  const tab: Tab = { info, term, fit, pane, exited: false };
  tabs.set(info.id, tab);

  term.onData((data) => void api.terminal.write(info.id, data));
  term.onResize(({ cols, rows }) => void api.terminal.resize(info.id, cols, rows));

  activeId = info.id;
  activate(info.id);
  // The pty was started at a default size; sync it to the real geometry.
  void api.terminal.resize(info.id, term.cols, term.rows);
  term.focus();
}

/**
 * ipcMain.handle wraps a thrown error as
 * "Error invoking remote method 'term:start': Error: <real message>".
 * The user only needs the real message.
 */
function cliErrorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function failurePanel(message: string): HTMLElement {
  const panel = h(
    'div',
    { class: 'terminal-pane', style: { padding: '26px', overflowY: 'auto' } },
    h(
      'div',
      { class: 'note danger', style: { maxWidth: '620px' } },
      h('div', {
        style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: '12.5px' },
        text: message,
      }),
    ),
  );
  panel.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '12px' } },
      h('button', {
        class: 'btn',
        text: 'Dismiss',
        on: {
          click: () => {
            panel.remove();
            if (tabs.size === 0 && host) host.appendChild(emptyState());
          },
        },
      }),
    ),
  );
  return panel;
}

function activate(id: string): void {
  activeId = id;
  for (const tab of tabs.values()) {
    tab.pane.hidden = tab.info.id !== id;
  }
  paintTabs();
  paintBanner();
  fitActive();
  tabs.get(id)?.term.focus();
}

async function closeTab(id: string): Promise<void> {
  const tab = tabs.get(id);
  if (!tab) return;
  await api.terminal.kill(id);
  tab.term.dispose();
  tab.pane.remove();
  tabs.delete(id);

  if (activeId === id) {
    const next = tabs.keys().next();
    activeId = next.done ? null : next.value;
  }
  paintTabs();
  paintBanner();
  if (tabs.size === 0 && host) host.appendChild(emptyState());
  else if (activeId) activate(activeId);
}

function fitActive(): void {
  if (!activeId) return;
  const tab = tabs.get(activeId);
  if (!tab || tab.pane.hidden) return;
  try {
    tab.fit.fit();
  } catch {
    // fit() throws while the pane has zero size, e.g. mid view transition.
  }
}

function handleTerminalEvent(event: TerminalEvent): void {
  const tab = tabs.get(event.id);
  if (!tab) return;

  switch (event.type) {
    case 'data':
      tab.term.write(event.data);
      break;
    case 'exit':
      tab.exited = true;
      tab.term.writeln(
        `\r\n\x1b[90m— session ended${event.code !== null ? ` (exit ${event.code})` : ''} —\x1b[0m`,
      );
      paintTabs();
      break;
    case 'error':
      tab.term.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
      toast(event.message, 'error');
      break;
  }
}

function terminalTheme(): Record<string, string> {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? {
        background: '#eceff6',
        foreground: '#131826',
        cursor: '#0284c7',
        selectionBackground: 'rgba(2,132,199,0.22)',
      }
    : {
        background: '#080b12',
        foreground: '#e6ebf5',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56,189,248,0.24)',
        black: '#1a2033',
        brightBlack: '#64708a',
        blue: '#60a5fa',
        cyan: '#22d3ee',
        green: '#34d399',
        magenta: '#a78bfa',
        red: '#f87171',
        yellow: '#fbbf24',
        white: '#e6ebf5',
      };
}

/**
 * Switches to the agents view and starts a session there. Used by the File menu,
 * Ctrl+T, and the desktop launcher's "Agent Terminal" action.
 */
export async function openAgentSession(provider?: ProviderId): Promise<void> {
  update({ view: 'agents' });
  // Let the view mount so `host` exists and has a measurable size.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await openTerminal(provider ?? state.settings.defaultProvider);
}

/** Opens a login session for a provider and switches to the agents view. */
export async function openLoginTerminal(provider: ProviderId): Promise<void> {
  update({ view: 'agents' });
  // Let the view mount before the terminal needs a sized host element.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  if (!host) return;
  host.querySelector('.empty')?.remove();

  try {
    attachTerminal(await api.auth.cliLogin(provider));
    toast(
      `Follow the prompts to sign in to ${PROVIDER_LABELS[provider]}. A browser window will open.`,
      'info',
      7000,
    );
  } catch (err) {
    host.appendChild(failurePanel(cliErrorMessage(err)));
  }
}

function shortenPath(dir: string): string {
  const home = dir.match(/^\/home\/[^/]+/)?.[0];
  const shown = home ? dir.replace(home, '~') : dir;
  return shown.length > 34 ? `…${shown.slice(-33)}` : shown;
}

export function teardownAgents(): void {
  // Deliberately not unsubscribing: terminals keep running while this view is
  // unmounted, and handleTerminalEvent is safe without a mounted DOM — writes
  // land in each pane's detached xterm buffer, paintTabs early-returns, and
  // toast mounts its own host.
  resizeObserver?.disconnect();
  resizeObserver = null;
  tabsBar = null;
  banner = null;
  host = null;
}
