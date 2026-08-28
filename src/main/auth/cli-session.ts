import { execFile } from 'node:child_process';
import type { ProviderId } from '@shared/types';
import { enrichedPath, resolveCliBinary } from '../agents/cli-detect';
import { createLogger } from '../util/logger';
import { parseClaudeAuthStatus, parseCodexLoginStatus, type SessionProbe } from './cli-session-parse';

const log = createLogger('cli-session');

/**
 * Asks each vendor CLI whether it is signed in, rather than reading its
 * credential file.
 *
 * This is the better question to ask for three reasons. The CLI is the only
 * thing that knows where it keeps its session — a file today, a keyring
 * tomorrow — so parsing one path guesses at an implementation detail that is
 * not ours. It reports *how* it authenticated, which a file cannot: an
 * ANTHROPIC_API_KEY the CLI happened to find is not a Pro/Max subscription, and
 * calling it one would recommend the wrong transport. And it answers without
 * this process ever holding a subscription token, which is the constraint the
 * whole design exists to satisfy.
 */

/** Long enough that the Login screen's 30s poll never spawns twice per check. */
const TTL_MS = 20_000;

interface Entry {
  probe: SessionProbe | null;
  at: number;
}

const cache = new Map<ProviderId, Entry>();
const inFlight = new Map<ProviderId, Promise<SessionProbe | null>>();

/** The probe last obtained, if it is still fresh. Never spawns. */
export function cachedSession(provider: ProviderId): SessionProbe | null {
  const entry = cache.get(provider);
  return entry && Date.now() - entry.at < TTL_MS ? entry.probe : null;
}

/** Forces the next call to re-ask — used right after a sign-in terminal opens. */
export function invalidateSession(provider: ProviderId): void {
  cache.delete(provider);
}

const STATUS_ARGS: Record<ProviderId, string[] | null> = {
  // GLM has no session of its own; it rides Claude Code with a Z.ai key.
  glm: null,
  anthropic: ['auth', 'status', '--json'],
  openai: ['login', 'status'],
  // Kimi Code has `login` and `logout` but no status command, so there is
  // nothing to ask. Detection falls back to the credential file, which is the
  // path this module was already built to degrade to.
  kimi: null,
};

/**
 * Keys are stripped from the probe's environment on purpose. A stray
 * ANTHROPIC_API_KEY in the user's shell profile would make the CLI report
 * api-key auth and mask a subscription session that is genuinely there.
 */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: enrichedPath() };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  return env;
}

function run(binary: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: 15_000, maxBuffer: 1_000_000, env: probeEnv() },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code ?? 1) : 0;
        // Both CLIs have printed this to stderr in some releases.
        resolve({ stdout: `${stdout ?? ''}\n${stderr ?? ''}`, code: typeof code === 'number' ? code : 1 });
      },
    );
  });
}

/**
 * Re-asks the CLI if the cached answer has expired. Returns null when the CLI
 * could not answer at all — the caller then falls back to reading the file,
 * which is still right for builds that predate these subcommands.
 */
export async function probeSession(provider: ProviderId): Promise<SessionProbe | null> {
  const fresh = cache.get(provider);
  if (fresh && Date.now() - fresh.at < TTL_MS) return fresh.probe;

  const existing = inFlight.get(provider);
  if (existing) return existing;

  const task = (async (): Promise<SessionProbe | null> => {
    const args = STATUS_ARGS[provider];
    const binary = args ? resolveCliBinary(provider) : null;
    if (!args || !binary) return null;

    const { stdout, code } = await run(binary, args);
    const probe =
      provider === 'openai' ? parseCodexLoginStatus(stdout, code) : parseClaudeAuthStatus(stdout);

    // Only the verdict is logged — the output can name the user's account.
    log.debug(`${provider} session probe: ${probe ? String(probe.loggedIn) : 'unanswered'}`);
    return probe;
  })();

  inFlight.set(provider, task);
  try {
    const probe = await task;
    cache.set(provider, { probe, at: Date.now() });
    return probe;
  } finally {
    inFlight.delete(provider);
  }
}
