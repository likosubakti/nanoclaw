import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MODELS, GLM_ENDPOINTS, DEFAULT_BASE_URLS } from '@shared/models';
import type { AppSettings, ProviderId, ProviderSettings } from '@shared/types';
import { SETTINGS_FILE, defaultWorkspace } from './paths';
import { createLogger } from '../util/logger';

const log = createLogger('settings');

const SETTINGS_VERSION = 1;

function defaultProvider(provider: ProviderId): ProviderSettings {
  return {
    enabled: true,
    baseUrl: '',
    endpointPreset: provider === 'glm' ? 'zai-global' : undefined,
    defaultModel: DEFAULT_MODELS[provider],
    // API transport is the default everywhere: it streams token-by-token and
    // does not depend on a CLI being installed. Users on a subscription plan
    // switch the provider to `cli` in Settings.
    transport: 'api',
    headers: {},
  };
}

export function defaultSettings(): AppSettings {
  return {
    version: SETTINGS_VERSION,
    theme: 'dark',
    fontSize: 14,
    defaultProvider: 'glm',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096,
    thinking: false,
    workspaceDir: defaultWorkspace(),
    sendOnEnter: true,
    providers: {
      glm: defaultProvider('glm'),
      anthropic: defaultProvider('anthropic'),
      openai: defaultProvider('openai'),
    },
  };
}

let cached: AppSettings | null = null;

/** Deep-merges a stored object over the defaults so new keys appear on upgrade. */
function merge(stored: unknown): AppSettings {
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;
  const raw = stored as Partial<AppSettings>;

  const providers = { ...base.providers };
  for (const id of Object.keys(providers) as ProviderId[]) {
    const incoming = raw.providers?.[id];
    if (incoming && typeof incoming === 'object') {
      providers[id] = { ...providers[id], ...incoming };
    }
  }

  return {
    ...base,
    ...raw,
    version: SETTINGS_VERSION,
    providers,
  };
}

export function loadSettings(): AppSettings {
  if (cached) return cached;
  try {
    cached = merge(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn('settings unreadable, falling back to defaults', err);
    cached = defaultSettings();
  }
  return cached;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings();

  // `merge` rebuilds providers from the defaults, so a patch carrying only one
  // provider would silently reset the other two. Fold the patch onto the
  // current providers first.
  const providers = { ...current.providers };
  if (patch.providers) {
    for (const id of Object.keys(providers) as ProviderId[]) {
      const incoming = patch.providers[id];
      if (incoming) providers[id] = { ...providers[id], ...incoming };
    }
  }

  const next = merge({ ...current, ...patch, providers });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  log.debug('settings saved');
  return next;
}

export function resetSettings(): AppSettings {
  cached = defaultSettings();
  writeFileSync(SETTINGS_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
  return cached;
}

/**
 * Resolves the HTTP base URL for a provider: explicit override first, then the
 * GLM region preset, then the vendor default. Always returned without a
 * trailing slash so callers can concatenate paths safely.
 */
export function resolveBaseUrl(provider: ProviderId, settings = loadSettings()): string {
  const config = settings.providers[provider];
  let url = config.baseUrl?.trim();

  if (!url && provider === 'glm') {
    const preset = config.endpointPreset ?? 'zai-global';
    if (preset !== 'custom') url = GLM_ENDPOINTS[preset].baseUrl;
  }

  return (url || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');
}

/**
 * The Anthropic-compatible base URL used when Claude Code drives this provider.
 * Only GLM has a meaningful non-default value here.
 */
export function resolveAnthropicCompatUrl(
  provider: ProviderId,
  settings = loadSettings(),
): string {
  if (provider !== 'glm') return resolveBaseUrl(provider, settings);
  const preset = settings.providers.glm.endpointPreset ?? 'zai-global';
  if (preset === 'custom') {
    const custom = settings.providers.glm.baseUrl?.trim();
    // Strip an OpenAI-style suffix if the user pasted one.
    if (custom) return custom.replace(/\/(api\/)?(coding\/)?paas\/v4\/?$/, '/api/anthropic');
  }
  return GLM_ENDPOINTS[preset === 'custom' ? 'zai-global' : preset].anthropicBaseUrl;
}
