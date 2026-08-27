import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

let logFile: string | null = null;

export function initLogger(dir: string): void {
  mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'glm-studio.log');
}

type Level = 'info' | 'warn' | 'error' | 'debug';

const DEBUG = process.env.GLM_STUDIO_DEBUG === '1' || process.env.GLM_STUDIO_DEV === '1';

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (level === 'debug' && !DEBUG) return;
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  const rendered = extra === undefined ? line : `${line} ${safeStringify(extra)}`;

  if (level === 'error') console.error(rendered);
  else if (level === 'warn') console.warn(rendered);
  else console.log(rendered);

  if (logFile) {
    try {
      appendFileSync(logFile, rendered + '\n');
    } catch {
      // A broken log file must never take the app down.
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    info: (message: string, extra?: unknown) => write('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => write('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => write('error', scope, message, extra),
    debug: (message: string, extra?: unknown) => write('debug', scope, message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
