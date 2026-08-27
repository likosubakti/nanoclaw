import type { ChatMessage, Conversation, ProviderId, StreamEvent } from '@shared/types';
import { PROVIDER_LABELS, PROVIDER_ORDER, modelsFor } from '@shared/models';
import { clear, h, icon } from '../lib/dom';
import { renderMarkdown } from '../lib/markdown';
import {
  api,
  providerInitials,
  refreshConversations,
  state,
  statusFor,
  toast,
  update,
} from '../state';

/**
 * The chat view.
 *
 * Streaming is append-only: each delta writes into a single live message node
 * rather than re-rendering the transcript, which keeps long conversations
 * smooth. A full re-render only happens when the conversation changes.
 */

let messagesEl: HTMLElement | null = null;
let composerEl: HTMLTextAreaElement | null = null;
let liveMessage: LiveMessage | null = null;
let unsubscribeStream: (() => void) | null = null;
/** True while the user is at the bottom, so new tokens should follow. */
let pinnedToBottom = true;

interface LiveMessage {
  streamId: string | null;
  /** The turn belongs to this thread even if the user switches away mid-stream. */
  conversationId: string;
  message: ChatMessage;
  root: HTMLElement;
  proseEl: HTMLElement;
  reasoningEl: HTMLElement | null;
  reasoningProse: HTMLElement | null;
  toolsEl: HTMLElement;
  footEl: HTMLElement;
  cursor: HTMLElement;
  text: string;
  reasoning: string;
  tools: string[];
  startedAt: number;
}

export function renderChat(container: HTMLElement): void {
  clear(container);

  const messages = h('div', { class: 'messages', attrs: { role: 'log', 'aria-live': 'polite' } });
  messagesEl = messages;

  messages.addEventListener('scroll', () => {
    const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    pinnedToBottom = distance < 80;
  });

  // Copy buttons live inside rendered Markdown, so they are handled by
  // delegation rather than wired up per code block.
  messages.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-action="copy-code"]');
    if (!target) return;
    const code = target.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard.writeText(code).then(() => {
      target.textContent = 'Copied';
      setTimeout(() => (target.textContent = 'Copy'), 1400);
    });
  });

  container.appendChild(messages);
  container.appendChild(buildComposer());

  paintTranscript();
  subscribeToStream();
}

/* --------------------------------------------------------------- header -- */

export function buildChatToolbar(): HTMLElement[] {
  const conversation = state.current;
  const provider = conversation?.provider ?? state.settings.defaultProvider;
  const transport = conversation?.transport ?? state.settings.providers[provider].transport;

  const providerSelect = h(
    'select',
    {
      class: 'inline',
      title: 'Backend',
      on: {
        change: (event) => {
          const next = (event.target as HTMLSelectElement).value as ProviderId;
          void switchProvider(next);
        },
      },
    },
    ...PROVIDER_ORDER.map((id) =>
      h('option', { value: id, text: PROVIDER_LABELS[id], attrs: { selected: id === provider } }),
    ),
  );

  const models = modelsFor(provider);
  const currentModel = conversation?.model ?? state.settings.providers[provider].defaultModel;
  // A model saved earlier may not be in the catalog; keep it selectable.
  const options = models.some((m) => m.id === currentModel)
    ? models
    : [{ id: currentModel, provider, label: currentModel }, ...models];

  const modelSelect = h(
    'select',
    {
      class: 'inline',
      title: 'Model',
      on: {
        change: (event) => {
          const model = (event.target as HTMLSelectElement).value;
          if (state.current) {
            state.current.model = model;
            void api.conversations.update(state.current);
          }
          void api.settings.set({
            providers: {
              ...state.settings.providers,
              [provider]: { ...state.settings.providers[provider], defaultModel: model },
            },
          });
        },
      },
    },
    ...options.map((m) =>
      h('option', {
        value: m.id,
        text: m.label,
        attrs: { selected: m.id === currentModel, title: m.note ?? '' },
      }),
    ),
  );

  const transportBadge = h('span', {
    class: `badge ${transport === 'cli' ? 'warn' : ''}`,
    text: transport === 'cli' ? 'via CLI' : 'via API',
    title:
      transport === 'cli'
        ? 'Requests run through the vendor CLI, so a subscription login works.'
        : 'Requests go straight to the provider HTTP API with your key.',
  });

  return [providerSelect, modelSelect, transportBadge];
}

async function switchProvider(provider: ProviderId): Promise<void> {
  const settings = state.settings;
  const model = settings.providers[provider].defaultModel;
  const transport = settings.providers[provider].transport;

  if (state.current && state.current.messages.length === 0) {
    // An untouched conversation just changes backend in place.
    Object.assign(state.current, { provider, model, transport, cliSessionId: undefined });
    await api.conversations.update(state.current);
  } else {
    // Mid-conversation the CLI session and transcript belong to the old
    // backend, so start a fresh thread rather than splicing histories.
    const created = await api.conversations.create({
      provider,
      model,
      transport,
      cwd: settings.workspaceDir,
    });
    update({ current: created });
    await refreshConversations();
  }
  await api.settings.set({ defaultProvider: provider });
  update({ settings: await api.settings.get() });
}

/* ------------------------------------------------------------ transcript -- */

function paintTranscript(): void {
  if (!messagesEl) return;
  clear(messagesEl);
  liveMessage = null;

  const conversation = state.current;
  if (!conversation || conversation.messages.length === 0) {
    messagesEl.appendChild(emptyState());
    return;
  }

  for (const message of conversation.messages) {
    messagesEl.appendChild(renderMessage(message, conversation.provider));
  }
  scrollToBottom(true);
}

function emptyState(): HTMLElement {
  const provider = state.current?.provider ?? state.settings.defaultProvider;
  const status = statusFor(provider);

  const suggestions = [
    'Explain what this repository does',
    'Write a bash script that rotates my logs',
    'Compare GLM-4.6 and Claude Sonnet for code review',
    'Refactor this function to be pure',
  ];

  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      {},
      h('div', { class: 'brand-mark', style: { width: '46px', height: '46px', margin: '0 auto' } }, h('span')),
      h('h2', { text: `Ask ${PROVIDER_LABELS[provider]} anything` }),
      h('p', {
        text: status?.ready
          ? 'Your message goes straight to the backend selected above. Switch backends any time from the header.'
          : `${PROVIDER_LABELS[provider]} is not connected yet — open Login & Providers to add a key or sign in.`,
      }),
      status?.ready
        ? h(
            'div',
            { class: 'suggestions' },
            ...suggestions.map((text) =>
              h('button', {
                class: 'suggestion',
                text,
                on: {
                  click: () => {
                    if (composerEl) {
                      composerEl.value = text;
                      composerEl.focus();
                      autosize(composerEl);
                    }
                  },
                },
              }),
            ),
          )
        : h('button', {
            class: 'btn primary',
            text: 'Open Login & Providers',
            on: { click: () => update({ view: 'login' }) },
          }),
    ),
  );
}

function renderMessage(message: ChatMessage, provider: ProviderId): HTMLElement {
  const isUser = message.role === 'user';
  const bubble = h('div', { class: 'bubble' });

  bubble.appendChild(
    h(
      'div',
      { class: 'bubble-head' },
      h('span', { class: 'who', text: isUser ? 'You' : PROVIDER_LABELS[message.meta?.provider ?? provider] }),
      message.meta?.model ? h('span', { text: message.meta.model }) : null,
    ),
  );

  if (message.reasoning) {
    const details = h('details', { class: 'reasoning' });
    details.appendChild(h('summary', { text: 'Reasoning' }));
    const prose = h('div', { class: 'prose' });
    prose.innerHTML = renderMarkdown(message.reasoning);
    details.appendChild(prose);
    bubble.appendChild(details);
  }

  if (message.meta?.tools?.length) {
    for (const tool of message.meta.tools) {
      bubble.appendChild(
        h('div', { class: 'tool-trace' }, h('span', { class: 'tool-name', text: tool })),
      );
    }
  }

  const prose = h('div', { class: 'prose' });
  // Safe: renderMarkdown escapes its input before emitting any tag.
  prose.innerHTML = renderMarkdown(message.content);
  bubble.appendChild(prose);

  if (message.error) {
    bubble.appendChild(errorBlock(message.error));
  }

  if (message.meta && !isUser) {
    const parts: string[] = [];
    if (message.meta.durationMs) parts.push(`${(message.meta.durationMs / 1000).toFixed(1)}s`);
    if (message.meta.outputTokens) {
      const input = message.meta.inputTokens ? `${message.meta.inputTokens} in / ` : '';
      parts.push(`${input}${message.meta.outputTokens} out`);
    }
    if (parts.length) {
      bubble.appendChild(
        h('div', { class: 'bubble-foot' }, ...parts.map((text) => h('span', { text }))),
      );
    }
  }

  return h(
    'div',
    { class: 'message' },
    h('div', {
      class: `avatar ${isUser ? 'user' : message.meta?.provider ?? provider}`,
      text: isUser ? 'You'.slice(0, 2).toUpperCase() : providerInitials(message.meta?.provider ?? provider),
    }),
    bubble,
  );
}

function errorBlock(message: string, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'message-error' },
    h('div', { class: 'err-title' }, icon('alert', 14), ' Request failed'),
    h('div', { text: message, style: { whiteSpace: 'pre-wrap' } }),
    hint ? h('div', { class: 'err-hint', text: hint }) : null,
  );
}

/* -------------------------------------------------------------- composer -- */

function buildComposer(): HTMLElement {
  const textarea = h('textarea', {
    rows: 1,
    placeholder: 'Send a message…  (Enter to send, Shift+Enter for a new line)',
    attrs: { 'aria-label': 'Message' },
    on: {
      input: (event) => autosize(event.target as HTMLTextAreaElement),
      keydown: (event) => {
        const e = event as KeyboardEvent;
        const wantsSend = state.settings.sendOnEnter
          ? e.key === 'Enter' && !e.shiftKey
          : e.key === 'Enter' && (e.ctrlKey || e.metaKey);
        if (wantsSend) {
          e.preventDefault();
          void send();
        }
      },
    },
  });
  composerEl = textarea;

  const sendButton = h(
    'button',
    { class: 'btn primary', attrs: { 'aria-label': 'Send' }, on: { click: () => void send() } },
    icon('send', 16),
  );

  const stopButton = h(
    'button',
    {
      class: 'btn',
      attrs: { 'aria-label': 'Stop generating' },
      style: { display: 'none' },
      on: {
        click: () => {
          if (state.streamId) void api.chat.abort(state.streamId);
        },
      },
    },
    icon('stop', 15),
    'Stop',
  );

  const footer = h(
    'div',
    { class: 'composer-foot' },
    h('span', {
      text: state.settings.sendOnEnter ? 'Enter to send' : 'Ctrl+Enter to send',
    }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'hint-transport', text: '' }),
  );

  const composer = h(
    'div',
    { class: 'composer' },
    h(
      'div',
      { class: 'composer-inner' },
      h('div', { class: 'composer-box' }, textarea, stopButton, sendButton),
      footer,
    ),
  );

  // Toggle Send/Stop from the shared stream state.
  const sync = () => {
    const streaming = Boolean(state.streamId);
    stopButton.style.display = streaming ? '' : 'none';
    sendButton.style.display = streaming ? 'none' : '';
    textarea.disabled = false;
  };
  sync();
  composer.dataset.sync = '1';
  (composer as HTMLElement & { sync?: () => void }).sync = sync;
  composerSync = sync;

  return composer;
}

let composerSync: (() => void) | null = null;

function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

/* --------------------------------------------------------------- sending -- */

async function send(): Promise<void> {
  if (!composerEl || state.streamId) return;
  const text = composerEl.value.trim();
  if (!text) return;

  let conversation = state.current;
  if (!conversation) {
    const provider = state.settings.defaultProvider;
    conversation = await api.conversations.create({
      provider,
      model: state.settings.providers[provider].defaultModel,
      transport: state.settings.providers[provider].transport,
      cwd: state.settings.workspaceDir,
    });
    update({ current: conversation });
  }

  const status = statusFor(conversation.provider);
  if (status && !status.ready) {
    toast(`${status.label} is not connected — open Login & Providers.`, 'error');
    update({ view: 'login' });
    return;
  }

  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  };

  composerEl.value = '';
  autosize(composerEl);

  // Drop the empty state before the first message lands.
  if (conversation.messages.length === 0 && messagesEl) clear(messagesEl);

  conversation.messages.push(userMessage);
  if (conversation.messages.filter((m) => m.role === 'user').length === 1) {
    conversation.title = deriveTitle(text);
  }
  messagesEl?.appendChild(renderMessage(userMessage, conversation.provider));
  scrollToBottom(true);

  await api.conversations.update(conversation);
  await refreshConversations();

  beginLiveMessage(conversation);

  await api.chat.send({
    conversationId: conversation.id,
    provider: conversation.provider,
    model: conversation.model,
    transport: conversation.transport,
    messages: conversation.messages,
    systemPrompt: state.settings.systemPrompt || undefined,
    temperature: state.settings.temperature,
    maxTokens: state.settings.maxTokens,
    thinking: state.settings.thinking,
    cwd: conversation.cwd ?? state.settings.workspaceDir,
    cliSessionId: conversation.cliSessionId,
  });
}

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}

function beginLiveMessage(conversation: Conversation): void {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    meta: {
      provider: conversation.provider,
      model: conversation.model,
      transport: conversation.transport,
    },
  };

  const prose = h('div', { class: 'prose' });
  const cursor = h('span', { class: 'cursor-blink' });
  prose.appendChild(cursor);
  const tools = h('div', {});
  const foot = h('div', { class: 'bubble-foot' }, h('span', { text: 'thinking…' }));

  const bubble = h(
    'div',
    { class: 'bubble' },
    h(
      'div',
      { class: 'bubble-head' },
      h('span', { class: 'who', text: PROVIDER_LABELS[conversation.provider] }),
      h('span', { text: conversation.model }),
    ),
    tools,
    prose,
    foot,
  );

  const root = h(
    'div',
    { class: 'message' },
    h('div', { class: `avatar ${conversation.provider}`, text: providerInitials(conversation.provider) }),
    bubble,
  );

  messagesEl?.appendChild(root);
  scrollToBottom(true);

  liveMessage = {
    streamId: null,
    conversationId: conversation.id,
    message,
    root,
    proseEl: prose,
    reasoningEl: null,
    reasoningProse: null,
    toolsEl: tools,
    footEl: foot,
    cursor,
    text: '',
    reasoning: '',
    tools: [],
    startedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- streaming -- */

function subscribeToStream(): void {
  unsubscribeStream?.();
  unsubscribeStream = api.chat.onEvent(handleStreamEvent);
}

function handleStreamEvent(event: StreamEvent): void {
  const live = liveMessage;

  switch (event.type) {
    case 'start':
      update({ streamId: event.streamId });
      composerSync?.();
      if (live) live.streamId = event.streamId;
      return;

    case 'text':
      if (!live) return;
      live.text += event.text;
      // Re-rendering the whole message keeps partial Markdown (an open code
      // fence, a half-written list) rendering correctly as it arrives.
      live.proseEl.innerHTML = renderMarkdown(live.text);
      live.proseEl.appendChild(live.cursor);
      scrollToBottom();
      return;

    case 'reasoning':
      if (!live) return;
      live.reasoning += event.text;
      if (!live.reasoningEl) {
        const details = h('details', { class: 'reasoning', attrs: { open: 'open' } });
        details.appendChild(h('summary', { text: 'Reasoning' }));
        const prose = h('div', { class: 'prose' });
        details.appendChild(prose);
        live.reasoningEl = details;
        live.reasoningProse = prose;
        live.proseEl.before(details);
      }
      live.reasoningProse!.innerHTML = renderMarkdown(live.reasoning);
      scrollToBottom();
      return;

    case 'tool': {
      if (!live) return;
      const label = event.detail ? `${event.name} · ${event.detail}` : event.name;
      live.tools.push(label);
      live.toolsEl.appendChild(
        h(
          'div',
          { class: 'tool-trace' },
          h('span', { class: 'tool-name', text: event.name }),
          event.detail ? h('span', { class: 'tool-detail', text: event.detail }) : null,
        ),
      );
      scrollToBottom();
      return;
    }

    case 'session': {
      const conversationId = live?.conversationId ?? state.current?.id;
      if (!conversationId) return;
      if (state.current?.id === conversationId) {
        state.current.cliSessionId = event.sessionId;
        void api.conversations.update(state.current);
      } else {
        void api.conversations.get(conversationId).then((target) => {
          if (!target) return;
          target.cliSessionId = event.sessionId;
          void api.conversations.update(target);
        });
      }
      return;
    }

    case 'usage':
      if (!live) return;
      if (event.inputTokens !== undefined) live.message.meta!.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) live.message.meta!.outputTokens = event.outputTokens;
      return;

    case 'done':
      finishLiveMessage(event.durationMs, event.finishReason);
      return;

    case 'error':
      finishLiveMessage(0, 'error', event.message, event.hint);
      return;
  }
}

function finishLiveMessage(
  durationMs: number,
  finishReason?: string,
  errorMessage?: string,
  hint?: string,
): void {
  update({ streamId: null });
  composerSync?.();

  const live = liveMessage;
  if (!live) return;
  liveMessage = null;

  live.cursor.remove();

  // Collapse the reasoning panel now that the answer is visible.
  live.reasoningEl?.removeAttribute('open');

  live.message.content = live.text;
  if (live.reasoning) live.message.reasoning = live.reasoning;
  if (live.tools.length) live.message.meta!.tools = live.tools;
  live.message.meta!.durationMs = durationMs || Date.now() - live.startedAt;

  clear(live.footEl);
  if (errorMessage) {
    live.message.error = hint ? `${errorMessage}\n\n${hint}` : errorMessage;
    live.proseEl.after(errorBlock(errorMessage, hint));
    if (!live.text) live.proseEl.remove();
  } else {
    if (finishReason === 'aborted') {
      live.footEl.appendChild(h('span', { text: 'stopped' }));
      if (!live.text) live.message.content = '_(stopped)_';
    }
    const seconds = (live.message.meta!.durationMs / 1000).toFixed(1);
    live.footEl.appendChild(h('span', { text: `${seconds}s` }));
    const out = live.message.meta!.outputTokens;
    if (out) {
      const input = live.message.meta!.inputTokens;
      live.footEl.appendChild(
        h('span', { text: `${input ? `${input} in / ` : ''}${out} out` }),
      );
    }
  }

  void appendToConversation(live.conversationId, live.message);
}

/**
 * Appends a completed turn to the thread it belongs to. The user may have
 * switched conversations while it was streaming, so the on-screen conversation
 * is not necessarily the right target.
 */
async function appendToConversation(conversationId: string, message: ChatMessage): Promise<void> {
  if (state.current?.id === conversationId) {
    state.current.messages.push(message);
    await api.conversations.update(state.current);
  } else {
    const target = await api.conversations.get(conversationId);
    if (!target) return;
    target.messages.push(message);
    await api.conversations.update(target);
  }
  await refreshConversations();
}

function scrollToBottom(force = false): void {
  if (!messagesEl) return;
  if (force || pinnedToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

/** Called by the shell after the conversation changes. */
export function repaintTranscript(): void {
  // Switching threads mid-turn: same reasoning as teardownChat.
  settleInFlightTurn();
  pinnedToBottom = true;
  paintTranscript();
}

export function focusComposer(): void {
  composerEl?.focus();
}

export function teardownChat(): void {
  // Leaving the view mid-turn would orphan the stream: its events would keep
  // arriving with nowhere to render, and the partial answer would be lost.
  settleInFlightTurn();

  unsubscribeStream?.();
  unsubscribeStream = null;
  messagesEl = null;
  composerEl = null;
  composerSync = null;
  liveMessage = null;
}

/** Saves an interrupted turn without touching DOM that is about to be discarded. */
function persistPartial(live: LiveMessage): void {
  live.message.content = live.text || '_(interrupted)_';
  if (live.reasoning) live.message.reasoning = live.reasoning;
  if (live.tools.length) live.message.meta!.tools = live.tools;
  live.message.meta!.durationMs = Date.now() - live.startedAt;
  void appendToConversation(live.conversationId, live.message);
}

/** Stops an in-flight turn and keeps what arrived. Shared by teardown and repaint. */
function settleInFlightTurn(): void {
  if (!liveMessage || !state.streamId) return;
  const streamId = state.streamId;
  // Written directly rather than through update(): both callers run inside the
  // shell's own re-render, and notifying subscribers here would recurse.
  state.streamId = null;
  void api.chat.abort(streamId);
  persistPartial(liveMessage);
  liveMessage = null;
}
