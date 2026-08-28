import { safeStorage } from 'electron';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderId } from '@shared/types';
import { ENV_KEY_NAMES } from '@shared/models';
import { SECRETS_FILE } from './paths';
import { createLogger } from '../util/logger';

const log = createLogger('secrets');

/**
 * API keys are held in the OS keyring via Electron's safeStorage, which on
 * Linux is backed by libsecret (GNOME Keyring / KWallet). When no keyring is
 * available — a bare tiling WM, a container, SSH without a session bus —
 * safeStorage refuses to encrypt. Rather than lose the feature, values are
 * then stored base64-encoded in a 0600 file and the UI is told so it can warn.
 *
 * Base64 is obfuscation, not protection. The warning matters.
 */

interface SecretsFile {
  version: number;
  /** 'keyring' entries are safeStorage ciphertext; 'plain' entries are base64. */
  backend: 'keyring' | 'file';
  values: Record<string, string>;
}

/**
 * Anything the vault holds. Provider keys plus the Telegram bot token, which is
 * a bearer credential in exactly the same sense and gets the same protection.
 */
type SecretKey = `${ProviderId}.apiKey` | 'telegram.botToken';

const EMPTY: SecretsFile = { version: 1, backend: 'file', values: {} };

let cache: SecretsFile | null = null;

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function secretsBackend(): 'keyring' | 'file' {
  return encryptionAvailable() ? 'keyring' : 'file';
}

function read(): SecretsFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) as SecretsFile;
    cache = { ...EMPTY, ...parsed, values: parsed.values ?? {} };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn('secrets file unreadable; starting empty', err);
    cache = { ...EMPTY, values: {} };
  }
  return cache;
}

function write(file: SecretsFile): void {
  writeFileSync(SECRETS_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  try {
    chmodSync(SECRETS_FILE, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
  cache = file;
}

export function setSecret(key: SecretKey, value: string): void {
  const file = read();
  const trimmed = value.trim();

  if (!trimmed) {
    delete file.values[key];
    write(file);
    return;
  }

  if (encryptionAvailable()) {
    file.values[key] = safeStorage.encryptString(trimmed).toString('base64');
    file.backend = 'keyring';
  } else {
    file.values[key] = Buffer.from(trimmed, 'utf8').toString('base64');
    file.backend = 'file';
    log.warn(
      'no OS keyring available — API key stored obfuscated in a 0600 file. ' +
        'Install gnome-keyring or kwallet for real encryption.',
    );
  }
  write(file);
}

export function getSecret(key: SecretKey): string | null {
  const file = read();
  const stored = file.values[key];
  if (!stored) return null;

  const buf = Buffer.from(stored, 'base64');
  if (file.backend === 'keyring') {
    try {
      return safeStorage.decryptString(buf);
    } catch (err) {
      // Happens when the keyring is locked, or the file moved between machines.
      log.error(`could not decrypt ${key}; re-enter the key in Settings`, err);
      return null;
    }
  }
  return buf.toString('utf8');
}

export function clearSecret(key: SecretKey): void {
  const file = read();
  delete file.values[key];
  write(file);
}

export function hasSecret(key: SecretKey): boolean {
  return Boolean(read().values[key]);
}

/**
 * Resolves a provider's key: the stored value wins, then any of the vendor's
 * conventional environment variables. Returns the source so the UI can show
 * where a working key came from.
 */
export function resolveApiKey(provider: ProviderId): { key: string; source: string } | null {
  const stored = getSecret(`${provider}.apiKey`);
  if (stored) return { key: stored, source: secretsBackend() === 'keyring' ? 'keyring' : 'config file' };

  for (const name of ENV_KEY_NAMES[provider]) {
    const value = process.env[name];
    if (value?.trim()) return { key: value.trim(), source: `$${name}` };
  }
  return null;
}

/** `sk-ant-…9f3c` — enough to recognise a key, not enough to use one. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
