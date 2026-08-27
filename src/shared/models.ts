import type { GlmEndpointPreset, ModelInfo, ProviderId } from './types';

/**
 * Endpoint presets for GLM. Z.ai runs three surfaces with different billing:
 * the general API, the cheaper Coding Plan surface used by coding agents, and
 * the mainland-China Bigmodel domain. Keys are not interchangeable between the
 * international (`z.ai`) and mainland (`bigmodel.cn`) platforms.
 */
export const GLM_ENDPOINTS: Record<
  Exclude<GlmEndpointPreset, 'custom'>,
  { label: string; baseUrl: string; anthropicBaseUrl: string; note: string }
> = {
  'zai-global': {
    label: 'Z.ai — International',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
    note: 'Pay-as-you-go API keys from z.ai',
  },
  'zai-coding': {
    label: 'Z.ai — Coding Plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
    note: 'Subscription surface used by the GLM Coding Plan',
  },
  'bigmodel-cn': {
    label: 'Bigmodel — Mainland China',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    note: 'open.bigmodel.cn keys (id.secret format supported)',
  },
};

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  glm: GLM_ENDPOINTS['zai-global'].baseUrl,
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  glm: 'GLM (Z.ai)',
  anthropic: 'Claude',
  openai: 'OpenAI',
};

export const PROVIDER_ORDER: ProviderId[] = ['glm', 'anthropic', 'openai'];

/** The CLI each provider drives in agent mode. */
export const PROVIDER_CLI: Record<ProviderId, { command: string; label: string; docs: string }> = {
  // GLM exposes an Anthropic-compatible surface, so Claude Code drives it once
  // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are pointed at Z.ai.
  glm: { command: 'claude', label: 'Claude Code → GLM', docs: 'https://docs.z.ai/scenario-example/develop-tools/claude' },
  anthropic: { command: 'claude', label: 'Claude Code', docs: 'https://docs.claude.com/en/docs/claude-code' },
  openai: { command: 'codex', label: 'Codex CLI', docs: 'https://developers.openai.com/codex/cli' },
};

/**
 * A starting catalog. The Settings screen can refresh this from each vendor's
 * /models endpoint, so a stale entry here is a cosmetic problem, not a blocker.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  // ---- GLM ---------------------------------------------------------------
  {
    id: 'glm-4.6',
    provider: 'glm',
    label: 'GLM-4.6',
    note: 'Flagship — strongest coding and agent performance',
    contextWindow: 200_000,
    supportsThinking: true,
    recommended: true,
  },
  {
    id: 'glm-4.5',
    provider: 'glm',
    label: 'GLM-4.5',
    note: 'Previous flagship, hybrid reasoning',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4.5-air',
    provider: 'glm',
    label: 'GLM-4.5-Air',
    note: 'Lighter and cheaper, same reasoning modes',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4.5-flash',
    provider: 'glm',
    label: 'GLM-4.5-Flash',
    note: 'Free tier — good for drafts and summaries',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4v',
    provider: 'glm',
    label: 'GLM-4V',
    note: 'Vision',
    contextWindow: 8_000,
    supportsVision: true,
  },

  // ---- Anthropic ---------------------------------------------------------
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.5',
    note: 'Balanced default for chat and code',
    contextWindow: 200_000,
    supportsThinking: true,
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    label: 'Claude Opus 4.5',
    note: 'Highest capability',
    contextWindow: 200_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    note: 'Fast and inexpensive',
    contextWindow: 200_000,
    supportsVision: true,
  },

  // ---- OpenAI ------------------------------------------------------------
  {
    id: 'gpt-5.1',
    provider: 'openai',
    label: 'GPT-5.1',
    note: 'General purpose flagship',
    contextWindow: 400_000,
    supportsThinking: true,
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'gpt-5.1-codex',
    provider: 'openai',
    label: 'GPT-5.1-Codex',
    note: 'Tuned for agentic coding — what Codex CLI uses',
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    label: 'GPT-5 mini',
    note: 'Cheaper, still reasoning-capable',
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    label: 'o4-mini',
    note: 'Reasoning-first, low cost',
    contextWindow: 200_000,
    supportsThinking: true,
  },
];

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  glm: 'glm-4.6',
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
};

export function modelsFor(provider: ProviderId): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

export function findModel(provider: ProviderId, id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.id === id);
}

/** Where each vendor lets you create an API key — opened by the login screen. */
export const API_KEY_PORTALS: Record<ProviderId, { url: string; label: string }> = {
  glm: { url: 'https://z.ai/manage-apikey/apikey-list', label: 'Z.ai API keys' },
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'Anthropic Console' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' },
};

/** Environment variables imported automatically when no key is stored. */
export const ENV_KEY_NAMES: Record<ProviderId, string[]> = {
  glm: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};
