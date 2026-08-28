import type { GlmEndpointPreset, KimiEndpointPreset, ModelInfo, ProviderId } from './types';

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

/**
 * Endpoint presets for Kimi (Moonshot AI) — the same three-surface split as
 * GLM, for the same reason. These URLs are not guesses: they are the platform
 * table inside Moonshot's own CLI (`kimi_cli/auth/platforms.py`), which is the
 * authority on where its client actually points.
 */
export const KIMI_ENDPOINTS: Record<
  Exclude<KimiEndpointPreset, 'custom'>,
  { label: string; baseUrl: string; note: string }
> = {
  'moonshot-global': {
    label: 'Moonshot — International',
    baseUrl: 'https://api.moonshot.ai/v1',
    note: 'Pay-as-you-go keys from platform.moonshot.ai',
  },
  'kimi-coding': {
    label: 'Kimi Code — Subscription',
    baseUrl: 'https://api.kimi.com/coding/v1',
    note: 'The surface the Kimi Code CLI signs in to',
  },
  'moonshot-cn': {
    label: 'Moonshot — Mainland China',
    baseUrl: 'https://api.moonshot.cn/v1',
    note: 'platform.moonshot.cn keys — a separate account from .ai',
  },
};

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  glm: GLM_ENDPOINTS['zai-global'].baseUrl,
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  kimi: KIMI_ENDPOINTS['moonshot-global'].baseUrl,
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  glm: 'GLM (Z.ai)',
  anthropic: 'Claude',
  openai: 'OpenAI',
  kimi: 'Kimi (Moonshot)',
};

export const PROVIDER_ORDER: ProviderId[] = ['glm', 'anthropic', 'openai', 'kimi'];

/** The CLI each provider drives in agent mode. */
export const PROVIDER_CLI: Record<ProviderId, { command: string; label: string; docs: string }> = {
  // GLM exposes an Anthropic-compatible surface, so Claude Code drives it once
  // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are pointed at Z.ai.
  glm: { command: 'claude', label: 'Claude Code → GLM', docs: 'https://docs.z.ai/scenario-example/develop-tools/claude' },
  anthropic: { command: 'claude', label: 'Claude Code', docs: 'https://docs.claude.com/en/docs/claude-code' },
  openai: { command: 'codex', label: 'Codex CLI', docs: 'https://developers.openai.com/codex/cli' },
  // Unlike GLM, Kimi ships its own agent CLI with its own OAuth sign-in, so it
  // does not need to borrow Claude Code.
  kimi: {
    command: 'kimi',
    label: 'Kimi Code CLI',
    docs: 'https://moonshotai.github.io/kimi-code/',
  },
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
    tier: 'flagship',
    note: 'Flagship — strongest coding and agent performance',
    contextWindow: 200_000,
    supportsThinking: true,
    recommended: true,
  },
  {
    id: 'glm-4.5',
    provider: 'glm',
    label: 'GLM-4.5',
    tier: 'flagship',
    note: 'Previous flagship, hybrid reasoning',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4.5-air',
    provider: 'glm',
    label: 'GLM-4.5-Air',
    tier: 'balanced',
    note: 'Lighter and cheaper, same reasoning modes',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4.5-flash',
    provider: 'glm',
    label: 'GLM-4.5-Flash',
    tier: 'fast',
    note: 'Free tier — good for drafts and summaries',
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    id: 'glm-4v',
    provider: 'glm',
    label: 'GLM-4V',
    tier: 'balanced',
    note: 'Vision',
    contextWindow: 8_000,
    supportsVision: true,
  },

  // ---- Anthropic ---------------------------------------------------------
  // Verified against the current Anthropic model list. Model ids are complete
  // as written — never append a date suffix.
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    tier: 'flagship',
    note: 'Flagship. Thinking on by default',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'claude-fable-5',
    provider: 'anthropic',
    label: 'Claude Fable 5',
    tier: 'flagship',
    note: 'Most capable. Thinking always on, priced above Opus',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    label: 'Claude Opus 4.8',
    tier: 'flagship',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    tier: 'flagship',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    label: 'Claude Opus 4.6',
    tier: 'flagship',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    tier: 'balanced',
    note: 'Strong and much cheaper than Opus',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    tier: 'balanced',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    tier: 'fast',
    note: 'Cheapest. Good for seats that only need an opinion',
    contextWindow: 200_000,
    supportsVision: true,
  },

  // ---- OpenAI ------------------------------------------------------------
  {
    id: 'gpt-5.1',
    provider: 'openai',
    label: 'GPT-5.1',
    tier: 'flagship',
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
    tier: 'flagship',
    note: 'Tuned for agentic coding — what Codex CLI uses',
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    label: 'GPT-5 mini',
    tier: 'balanced',
    note: 'Cheaper, still reasoning-capable',
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    id: 'o4-mini',
    provider: 'openai',
    label: 'o4-mini',
    tier: 'reasoning',
    note: 'Reasoning-first, low cost',
    contextWindow: 200_000,
    supportsThinking: true,
  },

  // ---- Kimi (Moonshot) ---------------------------------------------------
  // Only ids confirmed from Moonshot's own client and changelog are seeded
  // here. Context windows are deliberately absent rather than invented — the
  // refresh control beside the picker replaces this list with what the account
  // actually returns from /models, including the per-model context length.
  {
    id: 'kimi-k2.6',
    provider: 'kimi',
    label: 'Kimi K2.6',
    tier: 'flagship',
    note: 'Flagship — supports preserved thinking across turns',
    supportsThinking: true,
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'kimi-k2-thinking',
    provider: 'kimi',
    label: 'Kimi K2 Thinking',
    tier: 'reasoning',
    note: 'Always reasons; no way to switch thinking off',
    supportsThinking: true,
  },
  {
    id: 'kimi-k2.5',
    provider: 'kimi',
    label: 'Kimi K2.5',
    tier: 'balanced',
    note: 'Previous flagship generation',
    supportsThinking: true,
    supportsVision: true,
  },
  {
    id: 'kimi-k2-turbo-preview',
    provider: 'kimi',
    label: 'Kimi K2 Turbo',
    tier: 'fast',
    note: 'Faster K2 variant',
    supportsThinking: true,
  },
];

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  glm: 'glm-4.6',
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.1',
  kimi: 'kimi-k2.6',
};

export function modelsFor(provider: ProviderId): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

export const TIER_LABELS: Record<NonNullable<ModelInfo['tier']>, string> = {
  flagship: 'Flagship',
  balanced: 'Balanced',
  reasoning: 'Reasoning',
  fast: 'Fast & cheap',
};

/** Groups models by tier, in the order the picker should show them. */
export function modelsByTier(models: ModelInfo[]): Array<{ tier: string; models: ModelInfo[] }> {
  const order: Array<NonNullable<ModelInfo['tier']>> = ['flagship', 'balanced', 'reasoning', 'fast'];
  const groups = order
    .map((tier) => ({ tier: TIER_LABELS[tier], models: models.filter((m) => m.tier === tier) }))
    .filter((g) => g.models.length > 0);

  // Anything the catalog does not tier — a model fetched from the provider, or
  // one the user typed — still has to appear.
  const untiered = models.filter((m) => !m.tier);
  if (untiered.length) groups.push({ tier: 'Other', models: untiered });
  return groups;
}

export function findModel(provider: ProviderId, id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.id === id);
}

/** Where each vendor lets you create an API key — opened by the login screen. */
export const API_KEY_PORTALS: Record<ProviderId, { url: string; label: string }> = {
  glm: { url: 'https://z.ai/manage-apikey/apikey-list', label: 'Z.ai API keys' },
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'Anthropic Console' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' },
  kimi: { url: 'https://platform.moonshot.ai/console/api-keys', label: 'Moonshot Platform' },
};

/** Environment variables imported automatically when no key is stored. */
export const ENV_KEY_NAMES: Record<ProviderId, string[]> = {
  glm: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  // KIMI_API_KEY is the name Moonshot's own client reads.
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
};
