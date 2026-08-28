import type { Diagnostics, ProviderId } from '@shared/types';
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, PROVIDER_ORDER } from '@shared/models';
import { clear, h, icon } from '../lib/dom';
import { api, patchSettings, refreshStatuses, state, toast, update } from '../state';

/** Settings: behaviour, appearance, advanced per-provider overrides, diagnostics. */
export function renderSettings(container: HTMLElement): void {
  clear(container);
  const page = h('div', { class: 'scroll-page' });
  const inner = h('div', { class: 'page-inner' });
  page.appendChild(inner);
  container.appendChild(page);

  inner.appendChild(h('h1', { class: 'page-title', text: 'Settings' }));
  inner.appendChild(
    h('p', { class: 'page-sub', text: 'Applies to every backend unless a provider overrides it.' }),
  );

  inner.appendChild(generationCard());
  inner.appendChild(telegramCard());
  inner.appendChild(appearanceCard());
  inner.appendChild(workspaceCard());
  inner.appendChild(advancedCard());
  inner.appendChild(diagnosticsCard());
  inner.appendChild(dangerCard());
}

function generationCard(): HTMLElement {
  const settings = state.settings;

  const systemPrompt = h('textarea', {
    rows: 3,
    placeholder: 'Optional. Prepended to every conversation.',
    value: settings.systemPrompt,
    on: {
      change: (event) =>
        void patchSettings({ systemPrompt: (event.target as HTMLTextAreaElement).value }),
    },
  });

  const temperature = h('input', {
    type: 'number',
    min: '0',
    max: '2',
    step: '0.1',
    value: String(settings.temperature),
    on: {
      change: (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value)) void patchSettings({ temperature: clamp(value, 0, 2) });
      },
    },
  });

  const maxTokens = h('input', {
    type: 'number',
    min: '256',
    max: '200000',
    step: '256',
    value: String(settings.maxTokens),
    on: {
      change: (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value)) void patchSettings({ maxTokens: clamp(value, 256, 200_000) });
      },
    },
  });

  return card(
    'Generation',
    'Defaults for new turns.',
    h(
      'div',
      {},
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'label-text', text: 'System prompt' }),
        systemPrompt,
      ),
      h(
        'div',
        { class: 'grid-2' },
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'label-text', text: 'Temperature' }),
          temperature,
          h('span', {
            class: 'hint',
            text: 'Ignored by reasoning models (o-series, GPT-5) and when extended thinking is on.',
          }),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'label-text', text: 'Max output tokens' }),
          maxTokens,
        ),
      ),
      toggle('Extended thinking', settings.thinking, (checked) => patchSettings({ thinking: checked }),
        'Asks GLM-4.5+/Claude/o-series to show their reasoning. Slower and more expensive.'),
      toggle('Enter sends the message', settings.sendOnEnter, (checked) =>
        patchSettings({ sendOnEnter: checked }),
        'Off means Ctrl+Enter sends and Enter inserts a newline.'),
    ),
  );
}

function telegramCard(): HTMLElement {
  const body = h('div', {});

  const tokenInput = h('input', {
    type: 'password',
    placeholder: 'Bot token from @BotFather',
    attrs: { autocomplete: 'off', spellcheck: 'false' },
  });

  const statusLine = h('div', { class: 'note' }, 'Checking…');
  const pairLine = h('div', {});
  const chatsLine = h('div', {});

  const refresh = async () => {
    const status = await api.telegram.status();
    const settings = state.settings;

    clear(statusLine);
    statusLine.className = `note ${
      status.status === 'running' ? 'ok' : status.status === 'error' ? 'danger' : ''
    }`;
    statusLine.appendChild(
      h('div', {
        text:
          status.status === 'running'
            ? `Connected as @${status.username}. Watching for messages.`
            : status.status === 'error'
              ? `Not connected: ${status.error}`
              : 'Not connected.',
      }),
    );

    clear(pairLine);
    if (status.status === 'running' && status.allowedChatIds.length === 0) {
      pairLine.appendChild(
        h(
          'div',
          { class: 'note warn', style: { marginTop: '8px' } },
          h('div', { text: 'No chat is paired yet, so the bot will not answer anyone.' }),
          h(
            'div',
            { style: { marginTop: '6px' } },
            'Message your bot: ',
            h('code', { text: `/pair ${status.pairingCode}` }),
          ),
          h('div', {
            class: 'hint',
            text: 'The code changes each time the bridge starts, so an old screenshot cannot pair a chat later.',
          }),
        ),
      );
    }

    clear(chatsLine);
    if (status.allowedChatIds.length) {
      chatsLine.appendChild(
        h('span', { class: 'label-text', style: { marginTop: '10px' }, text: 'Paired chats' }),
      );
      for (const chatId of status.allowedChatIds) {
        chatsLine.appendChild(
          h(
            'div',
            { class: 'row', style: { marginTop: '5px' } },
            h('span', { class: 'badge ok', text: String(chatId) }),
            settings.telegram.broadcastChatId === chatId
              ? h('span', { class: 'badge', text: 'receives updates' })
              : null,
            h('span', { class: 'spacer' }),
            h('button', {
              class: 'btn danger',
              text: 'Unpair',
              on: {
                click: async () => {
                  await api.telegram.unpair(chatId);
                  update({ settings: await api.settings.get() });
                  void refresh();
                },
              },
            }),
          ),
        );
      }
    }
  };
  void refresh();

  body.appendChild(
    toggle(
      'Bridge to Telegram',
      state.settings.telegram.enabled,
      async (checked) => {
        await patchSettings({ telegram: { ...state.settings.telegram, enabled: checked } });
        if (checked) {
          const result = await api.telegram.start();
          toast(result.message, result.ok ? 'ok' : 'error', 8000);
        } else {
          await api.telegram.stop();
        }
        void refresh();
      },
      'Watch a discussion and start new rounds from your phone. Uses long polling, so no public URL or port forwarding is needed.',
    ),
  );

  body.appendChild(
    h(
      'div',
      { class: 'field', style: { marginBottom: '12px' } },
      h('span', { class: 'label-text', text: 'Bot token' }),
      h(
        'div',
        { class: 'key-row' },
        tokenInput,
        h(
          'button',
          {
            class: 'btn primary',
            on: {
              click: async () => {
                const token = tokenInput.value.trim();
                if (!token) return toast('Paste the token from @BotFather first.', 'error');
                await api.telegram.setToken(token);
                tokenInput.value = '';
                toast('Token saved to the keyring.', 'ok');
                if (state.settings.telegram.enabled) {
                  const result = await api.telegram.start();
                  toast(result.message, result.ok ? 'ok' : 'error', 8000);
                }
                void refresh();
              },
            },
          },
          'Save',
        ),
      ),
      h('span', {
        class: 'hint',
        text: 'Create a bot by messaging @BotFather on Telegram and sending /newbot. The token is stored with your API keys.',
      }),
    ),
  );

  body.appendChild(statusLine);
  body.appendChild(pairLine);
  body.appendChild(chatsLine);

  body.appendChild(
    h(
      'div',
      { class: 'note', style: { marginTop: '12px' } },
      h('div', {
        text: 'Anyone who finds your bot can message it, so the bridge answers nobody until a chat completes pairing. Paired chats can start rounds, which spends tokens — unpair a chat you no longer control.',
      }),
    ),
  );

  return card('Telegram', 'Follow a discussion, and run rounds, from anywhere.', body);
}

function appearanceCard(): HTMLElement {
  const settings = state.settings;

  const theme = h(
    'select',
    {
      on: {
        change: (event) =>
          void patchSettings({
            theme: (event.target as HTMLSelectElement).value as 'dark' | 'light' | 'system',
          }),
      },
    },
    ...(['dark', 'light', 'system'] as const).map((value) =>
      h('option', {
        value,
        text: value[0].toUpperCase() + value.slice(1),
        attrs: { selected: value === settings.theme },
      }),
    ),
  );

  const fontSize = h('input', {
    type: 'number',
    min: '11',
    max: '20',
    step: '1',
    value: String(settings.fontSize),
    on: {
      change: (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value)) void patchSettings({ fontSize: clamp(value, 11, 20) });
      },
    },
  });

  return card(
    'Appearance',
    undefined,
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', { class: 'label-text', text: 'Theme' }), theme),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'label-text', text: 'Base font size' }),
        fontSize,
      ),
    ),
  );
}

function workspaceCard(): HTMLElement {
  const value = h('input', { type: 'text', value: state.settings.workspaceDir, disabled: true });

  const browse = h(
    'button',
    {
      class: 'btn',
      on: {
        click: async () => {
          const picked = await api.app.pickDirectory(state.settings.workspaceDir);
          if (!picked) return;
          await patchSettings({ workspaceDir: picked });
          value.value = picked;
        },
      },
    },
    icon('folder', 14),
    'Browse',
  );

  return card(
    'Workspace',
    'Where agent terminals and CLI-transport turns run.',
    h('div', { class: 'key-row' }, value, browse),
  );
}

function advancedCard(): HTMLElement {
  const body = h('div', {});

  for (const provider of PROVIDER_ORDER) {
    const config = state.settings.providers[provider];

    const baseUrl = h('input', {
      type: 'text',
      value: config.baseUrl,
      placeholder: DEFAULT_BASE_URLS[provider],
      on: {
        change: async (event) => {
          const url = (event.target as HTMLInputElement).value.trim();
          await patchSettings({
            providers: {
              ...state.settings.providers,
              [provider]: {
                ...state.settings.providers[provider],
                baseUrl: url,
                // A hand-entered GLM URL only takes effect on the custom preset.
                ...(provider === 'glm' && url ? { endpointPreset: 'custom' as const } : {}),
              },
            },
          });
          await refreshStatuses();
        },
      },
    });

    const cliPath = h('input', {
      type: 'text',
      value: config.cliPath ?? '',
      placeholder: 'auto-detected on PATH',
      on: {
        change: async (event) => {
          await patchSettings({
            providers: {
              ...state.settings.providers,
              [provider]: {
                ...state.settings.providers[provider],
                cliPath: (event.target as HTMLInputElement).value.trim(),
              },
            },
          });
          await refreshStatuses();
        },
      },
    });

    body.appendChild(
      h(
        'div',
        { style: { marginBottom: '18px' } },
        h('div', {
          class: 'label-text',
          style: { marginBottom: '8px', fontWeight: '620', color: 'var(--text)' },
          text: PROVIDER_LABELS[provider],
        }),
        h(
          'div',
          { class: 'grid-2' },
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'label-text', text: 'Base URL' }),
            baseUrl,
          ),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'label-text', text: 'CLI path' }),
            cliPath,
          ),
        ),
      ),
    );
  }

  return card(
    'Advanced',
    'Point a provider at a gateway, a proxy, or a local OpenAI-compatible server. Leave blank for the default.',
    body,
  );
}

function diagnosticsCard(): HTMLElement {
  const body = h('div', {}, h('div', { class: 'note' }, h('span', { class: 'spinner' }), ' Loading…'));

  void api.app.diagnostics().then((diagnostics) => {
    clear(body);
    body.appendChild(diagnosticsTable(diagnostics));

    if (diagnostics.secretsBackend === 'file') {
      body.appendChild(
        h(
          'div',
          { class: 'note warn', style: { marginTop: '12px' } },
          h('div', {
            text: 'No OS keyring is available, so API keys are only obfuscated in a 0600 file rather than encrypted.',
          }),
          h('div', { style: { marginTop: '5px' } }, 'Install ', h('code', { text: 'gnome-keyring' }), ' or ', h('code', { text: 'kwalletmanager' }), ' and restart to fix this.'),
        ),
      );
    }

    if (!diagnostics.ptyAvailable) {
      body.appendChild(
        h(
          'div',
          { class: 'note warn', style: { marginTop: '8px' } },
          h('div', { text: 'node-pty is not built for this Electron version, so agent terminals run in pipe mode and cannot show interactive prompts.' }),
          h('div', { style: { marginTop: '5px' } }, 'Rebuild it with ', h('code', { text: 'npm rebuild node-pty' }), ' and restart.'),
        ),
      );
    }
  });

  return card('Diagnostics', 'Useful when something will not connect.', body);
}

function diagnosticsTable(diagnostics: Diagnostics): HTMLElement {
  const list = h('dl', { class: 'kv' });
  const rows: Array<[string, string]> = [
    ['App version', diagnostics.appVersion],
    ['Electron', diagnostics.electronVersion],
    ['Node', diagnostics.nodeVersion],
    ['Platform', diagnostics.platform],
    ['Config', diagnostics.configDir],
    ['Data', diagnostics.dataDir],
    ['Secret storage', diagnostics.secretsBackend === 'keyring' ? 'OS keyring (encrypted)' : 'file (obfuscated)'],
    ['Terminal backend', diagnostics.ptyAvailable ? 'node-pty' : 'pipes (degraded)'],
  ];

  for (const provider of diagnostics.providers) {
    rows.push([
      provider.label,
      [
        provider.ready ? 'ready' : 'not connected',
        provider.authMethod !== 'none' ? provider.authMethod : null,
        provider.cli.installed ? `${provider.cli.command} ${provider.cli.version ?? ''}`.trim() : `${provider.cli.command} missing`,
      ]
        .filter(Boolean)
        .join(' · '),
    ]);
  }

  for (const [key, value] of rows) {
    list.appendChild(h('dt', { text: key }));
    list.appendChild(h('dd', { text: value }));
  }

  const copy = h(
    'button',
    {
      class: 'btn',
      style: { marginTop: '12px' },
      on: {
        click: () => {
          const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
          void navigator.clipboard.writeText(text).then(() => toast('Diagnostics copied.', 'ok'));
        },
      },
    },
    icon('copy', 14),
    'Copy diagnostics',
  );

  return h('div', {}, list, copy);
}

function dangerCard(): HTMLElement {
  return card(
    'Reset',
    undefined,
    h(
      'div',
      { class: 'row wrap' },
      h('button', {
        class: 'btn danger',
        text: 'Reset settings to defaults',
        on: {
          click: async () => {
            const settings = await api.settings.reset();
            update({ settings });
            toast('Settings reset. API keys were kept.', 'ok');
          },
        },
      }),
      h('span', { class: 'hint', text: 'Stored API keys and conversations are not affected.' }),
    ),
  );
}

/* -------------------------------------------------------------- helpers -- */

function card(title: string, subtitle: string | undefined, body: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('div', { class: 'title', text: title }),
        subtitle ? h('div', { class: 'subtitle', text: subtitle }) : null,
      ),
    ),
    h('div', { class: 'card-body' }, body),
  );
}

function toggle(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  hint?: string,
): HTMLElement {
  return h(
    'div',
    { style: { marginBottom: '12px' } },
    h(
      'label',
      { class: 'switch' },
      h('input', {
        type: 'checkbox',
        checked,
        on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
      }),
      h('span', { text: label }),
    ),
    hint ? h('span', { class: 'hint', style: { marginTop: '4px' }, text: hint }) : null,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type { ProviderId };
