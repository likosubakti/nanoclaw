import type { ProviderId } from '@shared/types';
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
      const key = resolveApiKey('glm');
      if (key) {
        env.ANTHROPIC_BASE_URL = resolveAnthropicCompatUrl('glm', settings);
        env.ANTHROPIC_AUTH_TOKEN = key.key;
        // A stale ANTHROPIC_API_KEY in the user's shell profile would win over
        // AUTH_TOKEN and silently bill their Anthropic account instead.
        delete env.ANTHROPIC_API_KEY;
        // Claude Code refuses unknown model ids unless told they are intended.
        env.ANTHROPIC_MODEL = settings.providers.glm.defaultModel;
        env.ANTHROPIC_SMALL_FAST_MODEL = 'glm-4.5-air';
        env.API_TIMEOUT_MS = '600000';
      }
      break;
    }

    case 'anthropic': {
      const key = resolveApiKey('anthropic');
      // With no key, leave the environment alone: Claude Code then uses the
      // subscription session it already holds.
      if (key && settings.providers.anthropic.transport === 'api') {
        env.ANTHROPIC_API_KEY = key.key;
      }
      const base = settings.providers.anthropic.baseUrl?.trim();
      if (base) env.ANTHROPIC_BASE_URL = base;
      break;
    }

    case 'openai': {
      const key = resolveApiKey('openai');
      if (key && settings.providers.openai.transport === 'api') {
        env.OPENAI_API_KEY = key.key;
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
