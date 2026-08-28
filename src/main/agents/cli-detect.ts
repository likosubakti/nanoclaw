import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CliStatus, ProviderId } from '@shared/types';
import { PROVIDER_CLI } from '@shared/models';
import { loadSettings } from '../store/settings';
import { createLogger } from '../util/logger';

const execFileAsync = promisify(execFile);
const log = createLogger('cli-detect');

/**
 * A GUI launched from the desktop menu inherits a minimal PATH — typically
 * /usr/bin:/bin — not the one from the user's shell profile. Node and Bun
 * install their global binaries somewhere else entirely, so `claude` and
 * `codex` are usually invisible unless these locations are searched explicitly.
 */
function searchPath(): string[] {
  const home = os.homedir();
  const fromEnv = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extras = [
    path.join(home, '.local/bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.yarn/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.claude/local'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/snap/bin',
  ];

  // Volta uses flat shims. nvm and fnm give every installed Node version its
  // own bin directory, and the version root itself holds no executables — so
  // pushing the root, as this did, searched a directory that can never contain
  // `claude` and reported an installed CLI as missing.
  extras.push(path.join(home, '.volta/bin'));
  for (const [root, ...tail] of [
    ['.nvm/versions/node', 'bin'],
    ['.local/share/fnm/node-versions', 'installation', 'bin'],
  ] as const) {
    const base = path.join(home, root);
    let versions: string[];
    try {
      versions = readdirSync(base);
    } catch {
      continue; // this manager is not installed
    }
    // Newest first, compared numerically: readdir order is arbitrary, and a
    // stale v18 must not shadow the v22 the user actually installed into.
    for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      extras.push(path.join(base, version, ...tail));
    }
  }

  return [...new Set([...fromEnv, ...extras])];
}

/** PATH with the extra locations folded in, for spawning child processes. */
export function enrichedPath(): string {
  return searchPath().join(path.delimiter);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(command: string): string | null {
  if (command.includes('/')) return isExecutable(command) ? command : null;
  for (const dir of searchPath()) {
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

async function versionOf(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], {
      timeout: 10_000,
      env: { ...process.env, PATH: enrichedPath() },
    });
    // Output varies: "1.2.3", "claude 1.2.3 (Claude Code)", "codex-cli 0.4.0".
    return stdout.trim().split('\n')[0].slice(0, 80);
  } catch (err) {
    log.debug(`could not read version of ${binary}`, err);
    return undefined;
  }
}

/**
 * The binary this provider's CLI actually resolves to, honouring a Settings
 * override. Shared so that detection, capability probing, and the sign-in
 * probe all agree on which binary they are talking about.
 */
export function resolveCliBinary(provider: ProviderId): string | null {
  const override = loadSettings().providers[provider].cliPath?.trim();
  if (override) return isExecutable(override) ? override : null;
  return findExecutable(PROVIDER_CLI[provider].command);
}

/**
 * Locates the CLI for a provider and reports whether it is installed and
 * logged in. A configured override in Settings always wins over PATH lookup.
 */
export async function detectCli(
  provider: ProviderId,
  loggedIn: { loggedIn: boolean; accountHint?: string },
): Promise<CliStatus> {
  const command = PROVIDER_CLI[provider].command;
  const resolved = resolveCliBinary(provider);

  if (!resolved) {
    return { command, installed: false, loggedIn: false };
  }

  return {
    command,
    installed: true,
    path: resolved,
    version: await versionOf(resolved),
    loggedIn: loggedIn.loggedIn,
    accountHint: loggedIn.accountHint,
  };
}

/**
 * Which optional flags a CLI build actually accepts.
 *
 * These flags come and go between releases, and an unknown flag is not a soft
 * failure — the CLI exits non-zero and the turn is lost. Probing `--help` once
 * per binary lets the newest capabilities be used where they exist and skipped
 * where they do not.
 */
export interface CliCapabilities {
  systemPrompt: boolean;
  appendSystemPrompt: boolean;
  allowedTools: boolean;
  disallowedTools: boolean;
  /** `--tools` — the only flag that actually removes tools from the set. */
  tools: boolean;
  /** `--restricted` — also ignores the user's own permissive settings files. */
  restricted: boolean;
  partialMessages: boolean;
  excludeDynamicSections: boolean;
}

const capabilityCache = new Map<string, CliCapabilities>();

export async function probeCapabilities(binary: string): Promise<CliCapabilities> {
  const cached = capabilityCache.get(binary);
  if (cached) return cached;

  let help = '';
  try {
    const { stdout } = await execFileAsync(binary, ['--help'], {
      timeout: 15_000,
      maxBuffer: 4_000_000,
      env: { ...process.env, PATH: enrichedPath() },
    });
    help = stdout;
  } catch (err) {
    log.debug(`could not probe ${binary}`, err);
  }

  const has = (flag: string) => help.includes(flag);
  const capabilities: CliCapabilities = {
    systemPrompt: has('--system-prompt'),
    appendSystemPrompt: has('--append-system-prompt'),
    allowedTools: has('--allowedTools') || has('--allowed-tools'),
    disallowedTools: has('--disallowedTools') || has('--disallowed-tools'),
    // `--tools <tools...>` is its own entry in --help; the substring does not
    // occur inside --allowedTools / --disallowedTools.
    tools: has('--tools '),
    restricted: has('--restricted'),
    partialMessages: has('--include-partial-messages'),
    excludeDynamicSections: has('--exclude-dynamic-system-prompt-sections'),
  };
  capabilityCache.set(binary, capabilities);
  log.debug(`capabilities for ${binary}`, capabilities);
  return capabilities;
}

/** The subcommand that starts each CLI's own sign-in flow. */
export const CLI_LOGIN_ARGS: Record<ProviderId, string[]> = {
  // `claude auth login` is the documented entry point; bare `claude` only
  // prompts for sign-in when it happens to have no session. `--claudeai` is
  // today's default, but the button says "Sign in with Claude (Pro/Max)" — so
  // it is passed explicitly rather than left to a default that could change to
  // Console billing under the user.
  glm: ['auth', 'login', '--claudeai'],
  anthropic: ['auth', 'login', '--claudeai'],
  openai: ['login'],
  // `kimi-code login` runs a browser OAuth flow and stores the session itself,
  // exactly like the other two.
  kimi: ['login'],
};

/** Install hints shown when a CLI is missing. */
export const CLI_INSTALL_HINT: Record<ProviderId, string> = {
  glm: 'npm install -g @anthropic-ai/claude-code   (GLM Studio points it at Z.ai for you)',
  anthropic: 'npm install -g @anthropic-ai/claude-code',
  openai: 'npm install -g @openai/codex',
  // The scope matters: the unscoped npm package `kimi-cli` is an unrelated
  // 2018 scaffolding tool by a different author, and PyPI's `kimi-code` is
  // Moonshot's own but wound-down Python CLI.
  kimi: 'npm install -g @moonshot-ai/kimi-code',
};
