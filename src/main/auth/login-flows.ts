import { BrowserWindow, shell } from 'electron';
import type { ProviderId, ProviderStatus, TerminalInfo } from '@shared/types';
import { API_KEY_PORTALS, PROVIDER_CLI, PROVIDER_LABELS } from '@shared/models';
import { CLI_LOGIN_ARGS, detectCli } from '../agents/cli-detect';
import { startTerminal } from '../agents/terminal';
import { loadSettings } from '../store/settings';
import { maskKey, resolveApiKey } from '../store/secrets';
import { createLogger } from '../util/logger';
import { readCliCredentials } from './cli-credentials';

const log = createLogger('auth');

/**
 * Opens the vendor's API-key page in a real browser window.
 *
 * The key is never scraped out of the page. The user signs in with the vendor,
 * creates a key, copies it, and pastes it into the field beside the window.
 * Anything cleverer would mean intercepting a login session that belongs to
 * the vendor, not to this app.
 */
export function openKeyPortal(provider: ProviderId, parent?: BrowserWindow): void {
  const portal = API_KEY_PORTALS[provider];

  const window = new BrowserWindow({
    parent,
    width: 1100,
    height: 820,
    title: `${PROVIDER_LABELS[provider]} — ${portal.label}`,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f17',
    webPreferences: {
      // A dedicated persistent partition so the vendor login survives restarts
      // but stays isolated from the app's own session.
      partition: `persist:login-${provider}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Vendor pages open docs and OAuth popups; send those to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void window.loadURL(portal.url);
  log.info(`opened key portal for ${provider}`);
}

/**
 * Starts the vendor CLI's own login flow in an embedded terminal.
 *
 * `claude` and `codex` both run a browser-based OAuth handshake and store the
 * resulting session themselves. Driving them here means a Claude Pro/Max or
 * ChatGPT Plus/Pro subscription works in this app without the app ever holding
 * those tokens.
 */
export async function startCliLogin(provider: ProviderId): Promise<TerminalInfo> {
  const settings = loadSettings();

  const args = CLI_LOGIN_ARGS[provider];

  return startTerminal({
    provider,
    kind: 'agent',
    cwd: settings.workspaceDir,
    cols: 100,
    rows: 30,
    args,
  });
}

/** Everything the Login screen needs to render one provider's row. */
export async function providerStatus(provider: ProviderId): Promise<ProviderStatus> {
  const settings = loadSettings();
  const credentials = readCliCredentials(provider);
  const cli = await detectCli(provider, credentials);
  const apiKey = resolveApiKey(provider);

  const transport = settings.providers[provider].transport;
  const usableViaCli = cli.installed && (credentials.loggedIn || Boolean(apiKey));
  const ready = transport === 'cli' ? usableViaCli : Boolean(apiKey);

  const status: ProviderStatus = {
    provider,
    label: PROVIDER_LABELS[provider],
    ready,
    authMethod: apiKey ? 'api-key' : credentials.loggedIn ? 'cli-session' : 'none',
    maskedKey: apiKey ? maskKey(apiKey.key) : undefined,
    source: apiKey?.source ?? (credentials.loggedIn ? cli.command : undefined),
    cli,
    detail: describe(provider, transport, apiKey !== null, credentials.loggedIn, cli.installed),
  };
  return status;
}

function describe(
  provider: ProviderId,
  transport: string,
  hasKey: boolean,
  cliLoggedIn: boolean,
  cliInstalled: boolean,
): string {
  if (transport === 'cli') {
    if (!cliInstalled) return `${PROVIDER_CLI[provider].command} is not installed`;
    if (provider === 'glm') {
      return hasKey
        ? 'Claude Code pointed at Z.ai with your API key'
        : 'Needs a Z.ai API key to drive Claude Code';
    }
    if (cliLoggedIn) return 'Using the CLI’s signed-in subscription';
    if (hasKey) return 'Using your API key through the CLI';
    return 'CLI installed but not signed in';
  }
  return hasKey ? 'API key configured' : 'No API key yet';
}

/** Offers a key the vendor CLI already stores, for one-click import. */
export function importableKey(
  provider: ProviderId,
): { key: string; masked: string; source: string } | null {
  const state = readCliCredentials(provider);
  if (!state.importableKey) return null;
  return {
    key: state.importableKey,
    masked: maskKey(state.importableKey),
    source: state.importSource ?? 'the vendor CLI',
  };
}
