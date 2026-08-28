import type { ConversationSummary } from '@shared/types';
import { PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models';
import { clear, h, icon } from '../renderer/lib/dom';
import {
  api,
  loadSettings,
  refreshConversations,
  refreshStatuses,
  relativeTime,
  state,
  statusFor,
  subscribe,
  toast,
  update,
  type View,
} from './state';
import {
  buildAgentToolbar,
  openAgentSession,
  renderAgents,
  teardownAgents,
} from './views/agent';
import {
  buildChatToolbar,
  focusComposer,
  renderChat,
  repaintTranscript,
  teardownChat,
} from './views/chat';
import { renderLogin } from './views/login';
import {
  buildRoundtableToolbar,
  renderRoundtable,
  teardownRoundtable,
} from './views/roundtable';
import { renderSettings } from './views/settings';

/**
 * App shell: sidebar, top bar, and view switching.
 *
 * Views own their own DOM. The shell re-renders a view only when the active
 * view or its identity changes — not on every state update — so a streaming
 * chat or a live terminal is never torn out from under the user.
 */

const root = document.getElementById('root')!;

let sidebarEl: HTMLElement;
let topbarEl: HTMLElement;
let viewEl: HTMLElement;

/** What is currently mounted, so we can tell a real view change from a repaint. */
let mounted: { view: View; conversationId: string | null } = {
  view: 'chat',
  conversationId: null,
};

/** A route that arrived before the shell was ready to act on it. */
let pendingRoute: string | null = null;
let booted = false;

async function boot(): Promise<void> {
  // Registered before the first await. The main process routes desktop-action
  // flags (--agent, --new-chat) as soon as the renderer finishes loading, which
  // lands well before the rest of boot() completes; without this the very
  // navigation the user asked for on the command line is dropped.
  api.app.onNavigate((route) => {
    if (booted) handleNavigate(route);
    else pendingRoute = route;
  });

  await loadSettings();
  await Promise.all([refreshStatuses(), refreshConversations()]);

  // Open the most recent conversation, or start a fresh one.
  const [latest] = state.conversations;
  if (latest) {
    update({ current: await api.conversations.get(latest.id) });
  } else {
    await newConversation();
  }

  buildShell();
  subscribe(onStateChange);
  wireGlobalShortcuts();

  booted = true;
  if (pendingRoute) {
    handleNavigate(pendingRoute);
    pendingRoute = null;
  }

  // Providers can be connected outside the app (a CLI login in another
  // terminal, a keyring unlock), so refresh the badges periodically.
  setInterval(() => void refreshStatuses(), 30_000);

  // A theme set to "system" must follow the desktop.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.settings.theme === 'system') void loadSettings();
  });
}

/* --------------------------------------------------------------- shell --- */

function buildShell(): void {
  clear(root);

  sidebarEl = h('aside', { class: 'sidebar' });
  topbarEl = h('header', { class: 'topbar' });
  viewEl = h('section', { class: 'view' });

  root.appendChild(sidebarEl);
  root.appendChild(h('div', { class: 'main' }, topbarEl, viewEl));

  paintSidebar();
  paintTopbar();
  mountView(true);
}

function onStateChange(): void {
  paintSidebar();
  paintTopbar();
  mountView(false);
}

function mountView(force: boolean): void {
  const conversationId = state.current?.id ?? null;
  const viewChanged = mounted.view !== state.view;
  const conversationChanged = state.view === 'chat' && mounted.conversationId !== conversationId;

  if (!force && !viewChanged && !conversationChanged) {
    // Same view, same conversation: nothing structural to redo. Login and
    // Settings are cheap and data-driven, so repaint those in place — keeping
    // the scroll position, or changing one setting would jump to the top.
    if (state.view === 'login' || state.view === 'settings') {
      const scrollTop = viewEl.querySelector('.scroll-page')?.scrollTop ?? 0;
      if (state.view === 'login') renderLogin(viewEl);
      else renderSettings(viewEl);
      const restored = viewEl.querySelector('.scroll-page');
      if (restored) restored.scrollTop = scrollTop;
    }
    return;
  }

  if (viewChanged) {
    if (mounted.view === 'chat') teardownChat();
    if (mounted.view === 'agents') teardownAgents();
    if (mounted.view === 'roundtable') teardownRoundtable();
  }

  // Only a shortcut for an already-mounted chat view: on the first (forced)
  // mount there is no composer or transcript node to repaint into yet.
  if (!force && !viewChanged && conversationChanged && state.view === 'chat') {
    // Cheaper than a full remount, and keeps the composer's contents.
    repaintTranscript();
    mounted = { view: state.view, conversationId };
    return;
  }

  viewEl.className = 'view';
  clear(viewEl);

  switch (state.view) {
    case 'chat':
      renderChat(viewEl);
      break;
    case 'roundtable':
      renderRoundtable(viewEl);
      break;
    case 'agents':
      renderAgents(viewEl);
      break;
    case 'login':
      renderLogin(viewEl);
      break;
    case 'settings':
      renderSettings(viewEl);
      break;
  }

  root.dataset.view = state.view;
  mounted = { view: state.view, conversationId };
}

/* ------------------------------------------------------------- sidebar --- */

function paintSidebar(): void {
  clear(sidebarEl);

  sidebarEl.appendChild(
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark' }, h('span')),
      h('span', { text: 'GLM Studio' }),
    ),
  );

  const rail = h('nav', { class: 'rail', attrs: { role: 'tablist' } });
  const items: Array<[View, string, Parameters<typeof icon>[0]]> = [
    ['chat', 'Chat', 'chat'],
    ['roundtable', 'Room', 'users'],
    ['agents', 'Agents', 'terminal'],
    ['login', 'Login', 'key'],
  ];
  for (const [view, label, iconName] of items) {
    rail.appendChild(
      h(
        'button',
        {
          attrs: { role: 'tab', 'aria-selected': String(state.view === view) },
          on: { click: () => update({ view }) },
        },
        icon(iconName, 15),
        label,
      ),
    );
  }
  sidebarEl.appendChild(rail);

  // Conversation list only makes sense next to the chat view.
  if (state.view === 'chat') {
    sidebarEl.appendChild(
      h(
        'div',
        { class: 'sidebar-section' },
        h(
          'button',
          { class: 'btn', on: { click: () => void newConversation() } },
          icon('plus', 15),
          'New chat',
        ),
      ),
    );
    sidebarEl.appendChild(h('div', { class: 'section-label', text: 'Conversations' }));

    const list = h('div', { class: 'sidebar-scroll' });
    if (state.conversations.length === 0) {
      list.appendChild(
        h('div', {
          style: { padding: '8px 12px', color: 'var(--text-faint)', fontSize: '12.5px' },
          text: 'Nothing yet.',
        }),
      );
    }
    for (const summary of state.conversations) list.appendChild(conversationRow(summary));
    sidebarEl.appendChild(list);
  } else {
    sidebarEl.appendChild(h('div', { class: 'sidebar-scroll' }));
  }

  sidebarEl.appendChild(providerFooter());
}

function conversationRow(summary: ConversationSummary): HTMLElement {
  const row = h(
    'button',
    {
      class: 'conv-item',
      attrs: { 'aria-current': String(state.current?.id === summary.id) },
      on: {
        click: async () => update({ current: await api.conversations.get(summary.id) }),
        contextmenu: (event) => {
          event.preventDefault();
          void removeConversation(summary);
        },
      },
    },
    h('span', { class: 'conv-title', text: summary.title }),
    h(
      'span',
      { class: 'conv-meta' },
      h('span', { class: `dot ${summary.provider}` }),
      h('span', { text: PROVIDER_LABELS[summary.provider] }),
      h('span', { text: '·' }),
      h('span', { text: relativeTime(summary.updatedAt) }),
    ),
  );
  row.title = `${summary.title}\n${summary.model} · ${summary.messageCount} messages\nRight-click to delete`;
  return row;
}

async function removeConversation(summary: ConversationSummary): Promise<void> {
  const conversations = await api.conversations.remove(summary.id);
  update({ conversations });
  if (state.current?.id === summary.id) {
    const [next] = conversations;
    update({ current: next ? await api.conversations.get(next.id) : null });
    if (!next) await newConversation();
  }
  toast('Conversation deleted.', 'ok');
}

function providerFooter(): HTMLElement {
  const footer = h('div', { class: 'sidebar-footer' });
  for (const provider of PROVIDER_ORDER) {
    const status = statusFor(provider);
    footer.appendChild(
      h(
        'button',
        {
          class: 'status-chip',
          title: status?.detail ?? 'Checking…',
          on: { click: () => update({ view: 'login' }) },
        },
        h('span', { class: `dot ${status?.ready ? 'ok' : 'off'}` }),
        h('span', { class: 'chip-name', text: PROVIDER_LABELS[provider] }),
        status?.ready
          ? h('span', {
              class: 'chip-tag',
              text: state.settings.providers[provider].transport === 'cli' ? 'CLI' : 'API',
            })
          : h('span', { class: 'chip-tag', text: 'setup' }),
      ),
    );
  }
  footer.appendChild(
    h(
      'button',
      { class: 'status-chip', on: { click: () => update({ view: 'settings' }) } },
      icon('settings', 14),
      h('span', { class: 'chip-name', text: 'Settings' }),
    ),
  );
  return footer;
}

/* -------------------------------------------------------------- topbar --- */

function paintTopbar(): void {
  clear(topbarEl);

  switch (state.view) {
    case 'chat': {
      topbarEl.appendChild(
        h('span', { class: 'topbar-title', text: state.current?.title ?? 'New chat' }),
      );
      topbarEl.appendChild(h('span', { class: 'spacer' }));
      for (const control of buildChatToolbar()) topbarEl.appendChild(control);
      topbarEl.appendChild(
        h(
          'button',
          {
            class: 'btn ghost icon',
            title: 'Export as Markdown',
            on: { click: () => void exportCurrent() },
          },
          icon('download', 16),
        ),
      );
      break;
    }
    case 'roundtable':
      topbarEl.appendChild(h('span', { class: 'topbar-title', text: 'Roundtable' }));
      topbarEl.appendChild(h('span', { class: 'spacer' }));
      for (const control of buildRoundtableToolbar()) topbarEl.appendChild(control);
      break;
    case 'agents':
      topbarEl.appendChild(h('span', { class: 'topbar-title', text: 'Agent terminals' }));
      topbarEl.appendChild(h('span', { class: 'spacer' }));
      for (const control of buildAgentToolbar()) topbarEl.appendChild(control);
      break;
    case 'login':
      topbarEl.appendChild(h('span', { class: 'topbar-title', text: 'Login & Providers' }));
      topbarEl.appendChild(h('span', { class: 'spacer' }));
      topbarEl.appendChild(
        h(
          'button',
          { class: 'btn', on: { click: () => void refreshStatuses().then(() => update({})) } },
          icon('refresh', 14),
          'Re-check',
        ),
      );
      break;
    case 'settings':
      topbarEl.appendChild(h('span', { class: 'topbar-title', text: 'Settings' }));
      break;
  }
}

/* ------------------------------------------------------------- actions --- */

async function newConversation(): Promise<void> {
  const provider = state.settings.defaultProvider;
  const conversation = await api.conversations.create({
    provider,
    model: state.settings.providers[provider].defaultModel,
    transport: state.settings.providers[provider].transport,
    cwd: state.settings.workspaceDir,
  });
  update({ current: conversation, view: 'chat' });
  await refreshConversations();
  focusComposer();
}

async function exportCurrent(): Promise<void> {
  if (!state.current) return;
  const result = await api.conversations.export(state.current.id);
  if (result.saved) toast(`Exported to ${result.path}`, 'ok');
}

function handleNavigate(route: string): void {
  switch (route) {
    case 'new-chat':
      void newConversation();
      break;
    case 'new-terminal':
      // The menu item and Ctrl+T promise a new session, not just the view.
      void openAgentSession();
      break;
    case 'view-agents':
      update({ view: 'agents' });
      break;
    case 'view-chat':
      update({ view: 'chat' });
      break;
    case 'view-login':
      update({ view: 'login' });
      break;
    case 'view-roundtable':
      update({ view: 'roundtable' });
      break;
    case 'export':
      void exportCurrent();
      break;
  }
}

function wireGlobalShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    // Escape stops a running turn from anywhere in the chat view.
    if (event.key === 'Escape' && state.streamId) {
      void api.chat.abort(state.streamId);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      update({ view: 'settings' });
    }
  });
}

boot().catch((err) => {
  clear(root);
  root.appendChild(
    h(
      'div',
      { class: 'boot' },
      h(
        'div',
        { style: { textAlign: 'center', maxWidth: '540px' } },
        h('h2', { text: 'GLM Studio failed to start' }),
        h('p', { text: String(err?.message ?? err), style: { color: 'var(--text-muted)' } }),
        h('p', {
          text: 'Check the log at ~/.local/state/glm-studio/glm-studio.log',
          style: { color: 'var(--text-faint)', fontSize: '12px' },
        }),
      ),
    ),
  );
});
