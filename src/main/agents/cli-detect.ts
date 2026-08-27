import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
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

  // Every Node version managed by nvm/fnm/volta has its own bin directory.
  for (const manager of ['.nvm/versions/node', '.local/share/fnm/node-versions']) {
    extras.push(path.join(home, manager));
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
 * Locates the CLI for a provider and reports whether it is installed and
 * logged in. A configured override in Settings always wins over PATH lookup.
 */
export async function detectCli(
  provider: ProviderId,
  loggedIn: { loggedIn: boolean; accountHint?: string },
): Promise<CliStatus> {
  const command = PROVIDER_CLI[provider].command;
  const override = loadSettings().providers[provider].cliPath?.trim();
  const resolved = override ? (isExecutable(override) ? override : null) : findExecutable(command);

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

/** Install hints shown when a CLI is missing. */
export const CLI_INSTALL_HINT: Record<ProviderId, string> = {
  glm: 'npm install -g @anthropic-ai/claude-code   (GLM Studio points it at Z.ai for you)',
  anthropic: 'npm install -g @anthropic-ai/claude-code',
  openai: 'npm install -g @openai/codex',
};
