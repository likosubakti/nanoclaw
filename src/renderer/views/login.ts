import type { ProviderId, ProviderStatus, Transport } from '@shared/types';
import {
  API_KEY_PORTALS,
  GLM_ENDPOINTS, KIMI_ENDPOINTS,
  PROVIDER_CLI,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  modelsByTier,
} from '@shared/models';
import type { EndpointPreset } from '@shared/types';
import { clear, h, icon, modelSelect } from '../lib/dom';
import {
  api,
  modelsForProvider,
  refreshStatuses,
  setFetchedModels,
  state,
  statusFor,
  toast,
  update,
} from '../state';
import { openLoginTerminal } from './agent';

/**
 * Login & Providers.
 *
 * One card per backend, each offering the two ways in:
 *
 *   1. An API key — pasted, or imported from a vendor CLI that already has one.
 *   2. A subscription sign-in — handed to the vendor's own CLI, which owns
 *      that session. This app never stores or forwards subscription tokens.
 */

export function renderLogin(container: HTMLElement): void {
  clear(container);

  const page = h('div', { class: 'scroll-page' });
  const inner = h('div', { class: 'page-inner' });
  page.appendChild(inner);
  container.appendChild(page);

  inner.appendChild(h('h1', { class: 'page-title', text: 'Login & Providers' }));
  inner.appendChild(
    h('p', {
      class: 'page-sub',
      text: 'Connect each backend once. Keys are stored in your system keyring; subscription logins stay inside the vendor CLI that owns them.',
    }),
  );

  for (const provider of PROVIDER_ORDER) {
    inner.appendChild(providerCard(provider));
  }

  inner.appendChild(securityNote());
}

function providerCard(provider: ProviderId): HTMLElement {
  const status = statusFor(provider);
  const config = state.settings.providers[provider];

  const body = h('div', { class: 'card-body' });
  const card = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: `provider-badge ${provider}`, text: badgeText(provider) }),
      h(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'title', text: PROVIDER_LABELS[provider] }),
        h('div', { class: 'subtitle', text: status?.detail ?? 'Checking…' }),
      ),
      statusBadge(status),
    ),
    body,
  );

  body.appendChild(transportChooser(provider, config.transport));

  if (provider === 'glm' || provider === 'kimi') body.appendChild(endpointChooser(provider));

  body.appendChild(keyField(provider, status));
  body.appendChild(cliSection(provider, status));
  body.appendChild(actionRow(provider, config.transport));

  return card;
}

function badgeText(provider: ProviderId): string {
  return { glm: 'GLM', anthropic: 'CL', openai: 'AI', kimi: 'KM' }[provider];
}

function statusBadge(status?: ProviderStatus): HTMLElement {
  if (!status) return h('span', { class: 'badge', text: '…' });
  if (status.ready) {
    return h(
      'span',
      { class: 'badge ok' },
      icon('check', 12),
      status.authMethod === 'cli-session' ? 'Signed in' : 'Connected',
    );
  }
  return h('span', { class: 'badge warn' }, icon('alert', 12), 'Not connected');
}

/* ------------------------------------------------------------ transport -- */

function transportChooser(provider: ProviderId, current: Transport): HTMLElement {
  const options: Array<{ value: Transport; label: string; note: string }> = [
    {
      value: 'api',
      label: 'API key',
      note: 'Direct HTTP calls. Fastest, streams token by token.',
    },
    {
      value: 'cli',
      label: PROVIDER_CLI[provider].label,
      note:
        provider === 'glm'
          ? 'Runs Claude Code against Z.ai, so the agent can use tools and edit files.'
          : 'Runs the vendor CLI, so a subscription plan works and the agent can use tools.',
    },
  ];

  const wrapper = h('div', { class: 'field', style: { marginBottom: '16px' } });
  wrapper.appendChild(h('span', { class: 'label-text', text: 'How requests are sent' }));

  const row = h('div', { class: 'row wrap' });
  for (const option of options) {
    row.appendChild(
      h(
        'button',
        {
          class: `btn ${option.value === current ? 'primary' : ''}`,
          title: option.note,
          on: {
            click: async () => {
              await api.settings.set({
                providers: {
                  ...state.settings.providers,
                  [provider]: { ...state.settings.providers[provider], transport: option.value },
                },
              });
              update({ settings: await api.settings.get() });
              await refreshStatuses();
            },
          },
        },
        option.label,
      ),
    );
  }
  wrapper.appendChild(row);
  wrapper.appendChild(
    h('span', {
      class: 'hint',
      text: options.find((o) => o.value === current)?.note ?? '',
    }),
  );
  return wrapper;
}

/**
 * The endpoint picker, for the two providers that run more than one platform.
 *
 * GLM and Kimi both split into an international platform, a mainland-China one,
 * and a subscription surface — with accounts and keys that are not
 * interchangeable. Picking the wrong one is the single most common setup
 * mistake, which is why it is chosen here rather than buried in Advanced.
 */
function endpointChooser(provider: 'glm' | 'kimi'): HTMLElement {
  const endpoints = provider === 'glm' ? GLM_ENDPOINTS : KIMI_ENDPOINTS;
  const fallback = provider === 'glm' ? 'zai-global' : 'moonshot-global';
  const current = state.settings.providers[provider].endpointPreset ?? fallback;

  const select = h(
    'select',
    {
      on: {
        change: async (event) => {
          const preset = (event.target as HTMLSelectElement).value as EndpointPreset;
          await api.settings.set({
            providers: {
              ...state.settings.providers,
              [provider]: { ...state.settings.providers[provider], endpointPreset: preset },
            },
          });
          update({ settings: await api.settings.get() });
          await refreshStatuses();
        },
      },
    },
    ...Object.entries(endpoints).map(([value, meta]) =>
      h('option', { value, text: meta.label, attrs: { selected: value === current } }),
    ),
    h('option', { value: 'custom', text: 'Custom base URL', attrs: { selected: current === 'custom' } }),
  );

  const note =
    current === 'custom'
      ? 'Set the base URL under Settings → Advanced.'
      : ((endpoints as Record<string, { note: string }>)[current]?.note ?? '');

  const warning =
    provider === 'glm'
      ? 'Keys are not interchangeable between z.ai and open.bigmodel.cn.'
      : 'Keys are not interchangeable between platform.moonshot.ai and platform.moonshot.cn.';

  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'label-text', text: provider === 'glm' ? 'Z.ai endpoint' : 'Moonshot endpoint' }),
    select,
    h('span', { class: 'hint', text: `${note}  ·  ${warning}` }),
  );
}

/* ----------------------------------------------------------------- key --- */

function keyField(provider: ProviderId, status?: ProviderStatus): HTMLElement {
  const portal = API_KEY_PORTALS[provider];
  const hasKey = Boolean(status?.maskedKey);

  const input = h('input', {
    type: 'password',
    placeholder: hasKey ? `${status!.maskedKey} — stored` : 'Paste your API key',
    attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': `${PROVIDER_LABELS[provider]} API key` },
  });

  const save = h(
    'button',
    {
      class: 'btn primary',
      on: {
        click: async () => {
          const value = input.value.trim();
          if (!value) {
            toast('Paste a key first.', 'error');
            return;
          }
          await api.auth.setKey(provider, value);
          input.value = '';
          await refreshStatuses();
          toast(`${PROVIDER_LABELS[provider]} key saved.`, 'ok');
          rerender();
        },
      },
    },
    'Save',
  );

  const openPortal = h(
    'button',
    {
      class: 'btn',
      title: `Open ${portal.label} in a window — sign in there, create a key, and paste it here.`,
      on: { click: () => void api.auth.openPortal(provider) },
    },
    icon('external', 14),
    'Get a key',
  );

  const rows: HTMLElement[] = [h('div', { class: 'key-row' }, input, save, openPortal)];

  if (hasKey) {
    rows.push(
      h(
        'div',
        { class: 'row', style: { marginTop: '8px' } },
        h('span', {
          class: 'badge ok',
          text: `${status!.maskedKey} · from ${status!.source}`,
        }),
        h('button', {
          class: 'btn danger',
          text: 'Remove',
          on: {
            click: async () => {
              await api.auth.clearKey(provider);
              await refreshStatuses();
              toast(`${PROVIDER_LABELS[provider]} key removed.`, 'ok');
              rerender();
            },
          },
        }),
      ),
    );
  }

  const field = h(
    'div',
    { class: 'field', style: { marginBottom: '16px' } },
    h('span', { class: 'label-text', text: 'API key' }),
    ...rows,
  );

  // Offer a key the vendor CLI already holds — asked for, never silent.
  void api.auth.importable(provider).then((found) => {
    if (!found || hasKey) return;
    field.appendChild(
      h(
        'div',
        { class: 'note', style: { marginTop: '9px' } },
        h('div', { text: `Found a key in ${found.source}: ${found.masked}` }),
        h(
          'div',
          { class: 'row', style: { marginTop: '7px' } },
          h('button', {
            class: 'btn',
            text: 'Import it',
            on: {
              click: async () => {
                const result = await api.auth.importFromCli(provider);
                if (result.imported) {
                  await refreshStatuses();
                  toast(`Imported key from ${result.source}.`, 'ok');
                  rerender();
                }
              },
            },
          }),
        ),
      ),
    );
  });

  return field;
}

/* ----------------------------------------------------------------- cli --- */

function cliSection(provider: ProviderId, status?: ProviderStatus): HTMLElement {
  const cli = status?.cli;
  const section = h('div', { class: 'field', style: { marginBottom: '16px' } });
  section.appendChild(
    h('span', { class: 'label-text', text: `${PROVIDER_CLI[provider].label} (${cli?.command ?? ''})` }),
  );

  if (!cli?.installed) {
    section.appendChild(
      h(
        'div',
        { class: 'note warn' },
        h('div', { text: 'Not installed. Agent mode and subscription sign-in need it.' }),
        h('div', { style: { marginTop: '6px' } }, h('code', { text: installCommand(provider) })),
      ),
    );
    return section;
  }

  const row = h(
    'div',
    { class: 'row wrap' },
    h('span', { class: 'badge ok' }, icon('check', 12), cli.version ?? 'installed'),
    cli.loggedIn
      ? h('span', { class: 'badge ok', text: cli.accountHint ?? 'signed in' })
      : h('span', { class: 'badge', text: 'no session' }),
  );
  section.appendChild(row);

  // GLM is the only provider whose CLI is borrowed rather than its own — it is
  // Claude Code pointed at Z.ai, so there is no GLM account to sign in to.
  if (provider !== 'glm') {
    section.appendChild(
      h(
        'div',
        { class: 'row', style: { marginTop: '9px' } },
        h(
          'button',
          {
            class: cli.loggedIn ? 'btn' : 'btn primary',
            on: { click: () => void openLoginTerminal(provider) },
          },
          icon('key', 14),
          cli.loggedIn ? 'Sign in again' : `Sign in with ${subscriptionName(provider)}`,
        ),
      ),
    );
    section.appendChild(
      h('span', {
        class: 'hint',
        text: `Opens ${cli.command} in a terminal tab and follows its own browser sign-in. Your subscription session stays inside ${cli.command} — GLM Studio never reads or stores it.`,
      }),
    );
  }

  return section;
}

function subscriptionName(provider: ProviderId): string {
  if (provider === 'anthropic') return 'Claude (Pro/Max)';
  if (provider === 'kimi') return 'Kimi';
  return 'ChatGPT (Plus/Pro)';
}

function installCommand(provider: ProviderId): string {
  if (provider === 'openai') return 'npm install -g @openai/codex';
  // Kimi Code is a Python tool on PyPI needing 3.12+, so uv rather than npm.
  if (provider === 'kimi') return 'uv tool install kimi-code';
  return 'npm install -g @anthropic-ai/claude-code';
}

/* -------------------------------------------------------------- actions -- */

function actionRow(provider: ProviderId, transport: Transport): HTMLElement {
  const result = h('div', { style: { marginTop: '10px' } });

  const testButton = h(
    'button',
    {
      class: 'btn',
      on: {
        click: async () => {
          clear(result);
          result.appendChild(
            h('div', { class: 'note' }, h('span', { class: 'spinner' }), ' Testing…'),
          );
          const outcome = await api.auth.test(provider, transport);
          clear(result);
          result.appendChild(
            h(
              'div',
              { class: `note ${outcome.ok ? 'ok' : 'danger'}` },
              h('div', { text: outcome.message }),
              outcome.latencyMs
                ? h('div', { class: 'hint', text: `${outcome.latencyMs} ms` })
                : null,
              outcome.hint ? h('div', { style: { marginTop: '5px' }, text: outcome.hint }) : null,
            ),
          );
          await refreshStatuses();
        },
      },
    },
    icon('refresh', 14),
    'Test connection',
  );

  const modelPicker = modelSelect(
    modelsByTier(modelsForProvider(provider)),
    state.settings.providers[provider].defaultModel,
    async (model) => {
      await api.settings.set({
        providers: {
          ...state.settings.providers,
          [provider]: { ...state.settings.providers[provider], defaultModel: model },
        },
      });
      update({ settings: await api.settings.get() });
    },
    { class: 'inline', title: 'Default model' },
  );

  const refreshButton = h(
    'button',
    {
      class: 'btn ghost icon',
      title: 'Fetch the current model list from this provider',
      on: {
        click: async () => {
          clear(result);
          result.appendChild(
            h('div', { class: 'note' }, h('span', { class: 'spinner' }), ' Fetching models…'),
          );
          const fetched = await api.models.refresh(provider);
          clear(result);
          if (fetched.length === 0) {
            // A provider that cannot list models is not worth shouting about;
            // the built-in catalog still works.
            result.appendChild(
              h('div', {
                class: 'note warn',
                text: 'This provider did not return a model list. The built-in catalog is still in use.',
              }),
            );
            return;
          }
          setFetchedModels(provider, fetched);
          toast(`${fetched.length} models loaded from ${PROVIDER_LABELS[provider]}.`, 'ok');
          rerender();
        },
      },
    },
    icon('refresh', 14),
  );

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'row wrap' },
      h('span', { class: 'label-text', style: { margin: '0' }, text: 'Default model' }),
      modelPicker,
      refreshButton,
      h('span', { class: 'spacer' }),
      testButton,
    ),
    result,
  );
}

function securityNote(): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'title', text: 'How credentials are handled' })),
    h(
      'div',
      { class: 'card-body' },
      h(
        'ul',
        { style: { margin: '0', paddingLeft: '20px', color: 'var(--text-muted)', fontSize: '13px' } },
        h('li', {
          text: 'API keys are encrypted with your OS keyring (libsecret) and written to ~/.config/glm-studio/secrets.json. Without a keyring they fall back to an obfuscated 0600 file and Settings shows a warning.',
        }),
        h('li', {
          text: 'Subscription logins are never touched. Sign-in runs the vendor CLI, which stores its own session; GLM Studio only checks whether one exists.',
        }),
        h('li', {
          text: 'Keys are sent only to the endpoint you selected for that provider, and never appear in logs — headers are redacted before anything is written.',
        }),
      ),
    ),
  );
}

/** Re-renders the whole view after a change that alters card structure. */
function rerender(): void {
  if (state.view === 'login') update({});
}
