import { modelsFor as catalogFor } from '@shared/models';
import type {
  AppSettings,
  Conversation,
  ConversationSummary,
  ModelInfo,
  ProviderId,
  ProviderStatus,
} from '@shared/types';
import type { GlmApi } from '../preload/index';

declare global {
  interface Window {
    glm: GlmApi;
  }
}

export const api = window.glm;

export type View = 'chat' | 'roundtable' | 'agents' | 'login' | 'settings';

interface State {
  view: View;
  settings: AppSettings;
  statuses: ProviderStatus[];
  models: ModelInfo[];
  conversations: ConversationSummary[];
  current: Conversation | null;
  /** Set while a turn is streaming, so the composer can offer Stop. */
  streamId: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();

export const state: State = {
  view: 'chat',
  settings: null as unknown as AppSettings,
  statuses: [],
  models: [],
  conversations: [],
  current: null,
  streamId: null,
};

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies a patch and notifies subscribers once. */
export function update(patch: Partial<State>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener();
}

/* ------------------------------------------------------------- loaders --- */

export async function loadSettings(): Promise<AppSettings> {
  const settings = await api.settings.get();
  update({ settings });
  applyTheme(settings);
  return settings;
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  const settings = await api.settings.set(patch);
  update({ settings });
  applyTheme(settings);
}

/**
 * Serialised snapshot of the last statuses. The shell polls every 30 seconds to
 * notice a CLI login performed elsewhere; repainting on every poll would rebuild
 * the toolbar and close any dropdown the user had open.
 */
let lastStatuses = '';

export async function refreshStatuses(): Promise<void> {
  const statuses = await api.auth.status();
  const snapshot = JSON.stringify(statuses);
  if (snapshot === lastStatuses) return;
  lastStatuses = snapshot;
  update({ statuses });
}

export async function refreshConversations(): Promise<void> {
  update({ conversations: await api.conversations.list() });
}

export function applyTheme(settings: AppSettings): void {
  const root = document.documentElement;
  const theme =
    settings.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : settings.theme;
  root.setAttribute('data-theme', theme);
  root.style.setProperty('--font-size', `${settings.fontSize}px`);
}

/**
 * Models to offer for a provider.
 *
 * The built-in catalog goes stale as vendors ship models, so a list fetched
 * from the provider wins when one has been pulled. Falls back to the catalog,
 * which is what a user sees before they ever press Refresh.
 */
export function modelsForProvider(provider: ProviderId): ModelInfo[] {
  const fetched = state.models.filter((m) => m.provider === provider);
  return fetched.length > 0 ? fetched : catalogFor(provider);
}

/** Replaces the fetched list for one provider, leaving the others alone. */
export function setFetchedModels(provider: ProviderId, models: ModelInfo[]): void {
  update({ models: [...state.models.filter((m) => m.provider !== provider), ...models] });
}

export function statusFor(provider: ProviderId): ProviderStatus | undefined {
  return state.statuses.find((s) => s.provider === provider);
}

/* --------------------------------------------------------------- toasts -- */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info', ms = 4200): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.setAttribute('role', 'status');
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* -------------------------------------------------------------- helpers -- */

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function providerInitials(provider: ProviderId): string {
  return { glm: 'GLM', anthropic: 'CL', openai: 'AI', kimi: 'KM' }[provider];
}
