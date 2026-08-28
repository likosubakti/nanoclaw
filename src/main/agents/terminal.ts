import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { TerminalEvent, TerminalInfo, TerminalSpec } from '@shared/types';
import { PROVIDER_CLI } from '@shared/models';
import { CLI_INSTALL_HINT, detectCli, enrichedPath } from './cli-detect';
import { cliSessionState } from '../auth/cli-credentials';
import { invalidateSession } from '../auth/cli-session';
import { buildCliEnv } from './env';
import { createLogger } from '../util/logger';

const log = createLogger('terminal');

/**
 * node-pty is a native module. It is built with node-addon-api (N-API), so the
 * binary produced at install time works under Electron without an
 * Electron-specific rebuild — but it still has to have been built at all, and
 * that step fails on machines with no compiler or Python. Rather than lose the
 * feature, the terminal degrades to plain pipes. Pipe mode cannot run a full
 * TUI, so the UI is told which mode it got.
 */
type PtyModule = typeof import('node-pty');

let ptyModule: PtyModule | null = null;
let ptyChecked = false;

function loadPty(): PtyModule | null {
  if (ptyChecked) return ptyModule;
  ptyChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require('node-pty') as PtyModule;
    log.info('node-pty loaded — full terminal available');
  } catch (err) {
    log.warn('node-pty unavailable; terminals fall back to pipe mode', err);
    ptyModule = null;
  }
  return ptyModule;
}

export function ptyAvailable(): boolean {
  return loadPty() !== null;
}

interface Session {
  info: TerminalInfo;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const sessions = new Map<string, Session>();

export type TerminalListener = (event: TerminalEvent) => void;
let listener: TerminalListener = () => {};

export function onTerminalEvent(fn: TerminalListener): void {
  listener = fn;
}

/** Resolves what to run for a spec, or explains why it cannot run. */
async function resolveCommand(
  spec: TerminalSpec,
): Promise<{ file: string; args: string[]; label: string }> {
  if (spec.kind === 'shell') {
    const shell = process.env.SHELL || '/bin/bash';
    return { file: shell, args: ['-l'], label: shell };
  }

  const status = await detectCli(spec.provider, await cliSessionState(spec.provider));
  if (!status.installed || !status.path) {
    throw new Error(
      `${PROVIDER_CLI[spec.provider].label} is not installed.\n\nInstall it with:\n  ${CLI_INSTALL_HINT[spec.provider]}\n\nThen reopen this tab.`,
    );
  }
  return {
    file: status.path,
    args: spec.args ?? [],
    label: PROVIDER_CLI[spec.provider].label,
  };
}

export async function startTerminal(spec: TerminalSpec): Promise<TerminalInfo> {
  const { file, args } = await resolveCommand(spec);
  const cwd = existsSync(spec.cwd) ? spec.cwd : os.homedir();
  const env = buildCliEnv(spec.provider);
  const id = randomUUID();
  const cols = Math.max(20, spec.cols || 80);
  const rows = Math.max(5, spec.rows || 24);

  const info: TerminalInfo = {
    id,
    spec: { ...spec, cwd },
    commandLine: [file, ...args].join(' '),
    pty: ptyAvailable(),
    startedAt: Date.now(),
  };

  const pty = loadPty();
  if (pty) {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    proc.onData((data) => listener({ type: 'data', id, data }));
    proc.onExit(({ exitCode, signal }) => {
      sessions.delete(id);
      // A finished sign-in — or an agent run that refreshed or expired the
      // session — makes the cached "is there a session" answer stale.
      invalidateSession(spec.provider);
      listener({ type: 'exit', id, code: exitCode, signal: signal ? String(signal) : undefined });
    });

    sessions.set(id, {
      info,
      write: (data) => proc.write(data),
      resize: (c, r) => {
        try {
          proc.resize(Math.max(1, c), Math.max(1, r));
        } catch (err) {
          log.debug('resize failed', err);
        }
      },
      kill: () => proc.kill(),
    });
  } else {
    const child: ChildProcess = spawnProcess(file, args, {
      cwd,
      env: { ...env, PATH: enrichedPath(), TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (d: Buffer) =>
      listener({ type: 'data', id, data: d.toString('utf8') }),
    );
    child.stderr?.on('data', (d: Buffer) =>
      listener({ type: 'data', id, data: d.toString('utf8') }),
    );
    child.on('error', (err) => listener({ type: 'error', id, message: err.message }));
    child.on('close', (code, signal) => {
      sessions.delete(id);
      invalidateSession(spec.provider);
      listener({ type: 'exit', id, code, signal: signal ?? undefined });
    });

    listener({
      type: 'data',
      id,
      data:
        '\x1b[33m⚠ Running in pipe mode: the node-pty native binary is missing.\r\n' +
        '  Interactive prompts and full-screen UIs will not render.\r\n' +
        '  Fix with: npm rebuild node-pty\x1b[0m\r\n\r\n',
    });

    sessions.set(id, {
      info,
      write: (data) => child.stdin?.write(data),
      resize: () => {},
      kill: () => child.kill(),
    });
  }

  log.info(`terminal ${id} started: ${info.commandLine} (pty=${info.pty})`);
  return info;
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows);
}

export function killTerminal(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.kill();
  sessions.delete(id);
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map((s) => s.info);
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id);
}
