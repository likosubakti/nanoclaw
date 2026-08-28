import type { AppSettings, ProviderId } from '@shared/types';
import { readCliCredentials } from '../auth/cli-credentials';
import { resolveApiKey } from '../store/secrets';
import { loadSettings, resolveAnthropicCompatUrl, resolveBaseUrl } from '../store/settings';
import { enrichedPath } from './cli-detect';

/**
 * Builds the environment a vendor CLI is launched with.
 *
 * The interesting case is GLM: Z.ai publishes an Anthropic-compatible surface,
 * so Claude Code drives GLM unchanged once ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN point at it. That is how one agent binary ends up
 * serving two of the three backends.
 */
/**
 * Whether to hand the CLI our stored API key.
 *
 * On the `api` transport the user has asked for key-based billing, so the key
 * goes through. On the `cli` transport they asked for the subscription — but
 * only a CLI that actually holds a session can serve that, so when there is no
 * session the key is still passed rather than letting the run fail. This has to
 * agree with CliProvider.test(), which reports "ready" on exactly that basis.
 */
function shouldPassKey(provider: 'anthropic' | 'openai', settings: AppSettings): boolean {
  if (!resolveApiKey(provider)) return false;
  if (settings.providers[provider].transport === 'api') return true;
  return !readCliCredentials(provider).loggedIn;
}

export function buildCliEnv(provider: ProviderId): NodeJS.ProcessEnv {
  const settings = loadSettings();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: enrichedPath(),
    // Tell the CLI it is inside a real terminal so it renders its full TUI.
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    GLM_STUDIO: '1',
  };

  switch (provider) {
    case 'glm': {
      // Unconditionally, before anything else: a stale ANTHROPIC_API_KEY in the
      // user's shell profile wins over AUTH_TOKEN when one is set, and without
      // one it points a session labelled "GLM" straight at api.anthropic.com,
      // billed to their Anthropic account. Neither is acceptable, so it goes
      // whether or not a Z.ai key exists.
      delete env.ANTHROPIC_API_KEY;

      const key = resolveApiKey('glm');
      if (key) {
        env.ANTHROPIC_BASE_URL = resolveAnthropicCompatUrl('glm', settings);
        env.ANTHROPIC_AUTH_TOKEN = key.key;
        // Claude Code refuses unknown model ids unless told they are intended.
        env.ANTHROPIC_MODEL = settings.providers.glm.defaultModel;
        env.ANTHROPIC_SMALL_FAST_MODEL = 'glm-4.5-air';
        env.API_TIMEOUT_MS = '600000';
      }
      break;
    }

    case 'anthropic': {
      if (shouldPassKey('anthropic', settings)) {
        env.ANTHROPIC_API_KEY = resolveApiKey('anthropic')!.key;
      }
      const base = settings.providers.anthropic.baseUrl?.trim();
      if (base) env.ANTHROPIC_BASE_URL = base;
      break;
    }

    case 'openai': {
      if (shouldPassKey('openai', settings)) {
        env.OPENAI_API_KEY = resolveApiKey('openai')!.key;
      }
      const base = settings.providers.openai.baseUrl?.trim();
      if (base && base !== resolveBaseUrl('openai', settings)) env.OPENAI_BASE_URL = base;
      break;
    }
  }

  return env;
}

/** A one-line, credential-free summary of what the CLI will be pointed at. */
export function describeCliEnv(provider: ProviderId): string {
  const settings = loadSettings();
  switch (provider) {
    case 'glm':
      return `Claude Code → ${resolveAnthropicCompatUrl('glm', settings)} (${settings.providers.glm.defaultModel})`;
    case 'anthropic':
      return resolveApiKey('anthropic')
        ? 'Claude Code with your API key'
        : 'Claude Code with its own signed-in session';
    case 'openai':
      return resolveApiKey('openai')
        ? 'Codex CLI with your API key'
        : 'Codex CLI with its own signed-in session';
  }
}
