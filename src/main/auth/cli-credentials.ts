import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderId } from '@shared/types';
import { createLogger } from '../util/logger';

const log = createLogger('cli-credentials');

/**
 * Reads whether the vendor CLIs are already signed in.
 *
 * Deliberate scope limit: this only ever *reads* enough to answer "is there a
 * session, and whose is it". Subscription tokens are never copied out of the
 * CLI's store or sent anywhere — when a user picks a subscription login, the
 * CLI itself makes the request. API keys sitting in those files are offered as
 * an explicit, user-confirmed import, never silently adopted.
 */

const home = os.homedir();

export interface CliCredentialState {
  loggedIn: boolean;
  accountHint?: string;
  /** An API key found in the CLI's own config, offerable as an import. */
  importableKey?: string;
  importSource?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug(`could not read ${file}`, err);
    }
    return null;
  }
}

/** Pulls the `email` claim out of an id_token without verifying it. Display only. */
function emailFromJwt(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return (
      payload.email ??
      payload.preferred_username ??
      payload['https://api.openai.com/auth']?.user_email
    );
  } catch {
    return undefined;
  }
}

function claudeState(): CliCredentialState {
  // Claude Code keeps OAuth tokens here (or in the system keyring on macOS).
  const credentials = readJson<{
    claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
  }>(path.join(home, '.claude', '.credentials.json'));

  // Account metadata lives in the top-level config.
  const config = readJson<{
    oauthAccount?: { emailAddress?: string; organizationName?: string };
    primaryApiKey?: string;
  }>(path.join(home, '.claude.json'));

  const oauth = credentials?.claudeAiOauth;
  const expired = oauth?.expiresAt ? oauth.expiresAt < Date.now() : false;
  const email = config?.oauthAccount?.emailAddress;

  const state: CliCredentialState = {
    loggedIn: Boolean(oauth?.accessToken) && !expired,
  };
  if (state.loggedIn) {
    const plan = oauth?.subscriptionType ? ` · ${oauth.subscriptionType}` : '';
    state.accountHint = `${email ?? 'signed in'}${plan}`;
  } else if (oauth?.accessToken && expired) {
    state.accountHint = 'session expired — run `claude` to refresh';
  }

  if (config?.primaryApiKey) {
    state.importableKey = config.primaryApiKey;
    state.importSource = '~/.claude.json';
  }
  return state;
}

function codexState(): CliCredentialState {
  const auth = readJson<{
    OPENAI_API_KEY?: string | null;
    tokens?: { id_token?: string; access_token?: string; account_id?: string };
    last_refresh?: string;
  }>(path.join(home, '.codex', 'auth.json'));

  if (!auth) return { loggedIn: false };

  const state: CliCredentialState = { loggedIn: Boolean(auth.tokens?.access_token) };
  if (state.loggedIn && auth.tokens?.id_token) {
    state.accountHint = emailFromJwt(auth.tokens.id_token) ?? 'signed in with ChatGPT';
  } else if (state.loggedIn) {
    state.accountHint = 'signed in with ChatGPT';
  }

  if (auth.OPENAI_API_KEY) {
    state.importableKey = auth.OPENAI_API_KEY;
    state.importSource = '~/.codex/auth.json';
  }
  return state;
}

/**
 * GLM has no desktop login of its own — it authenticates with an API key. When
 * a user has already wired Claude Code to Z.ai, the key is in that CLI's
 * settings and worth offering as an import.
 */
function glmState(): CliCredentialState {
  const settings = readJson<{ env?: Record<string, string> }>(
    path.join(home, '.claude', 'settings.json'),
  );
  const env = settings?.env ?? {};
  const base = env.ANTHROPIC_BASE_URL ?? '';
  const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;

  if (token && /z\.ai|bigmodel\.cn/.test(base)) {
    return {
      loggedIn: false,
      importableKey: token,
      importSource: '~/.claude/settings.json (Z.ai)',
    };
  }
  return { loggedIn: false };
}

export function readCliCredentials(provider: ProviderId): CliCredentialState {
  switch (provider) {
    case 'anthropic':
      return claudeState();
    case 'openai':
      return codexState();
    case 'glm':
      return glmState();
  }
}
