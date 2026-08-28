import { createLogger } from '../util/logger';

const log = createLogger('telegram:api');

/**
 * The slice of the Telegram Bot API this bridge needs.
 *
 * Long polling rather than webhooks on purpose: a desktop app has no public
 * URL, and asking a user to expose one would be absurd. getUpdates works from
 * behind any NAT.
 */

/** Overridable so the bridge can be tested against a local stub. */
export const TELEGRAM_BASE =
  process.env.GLM_STUDIO_TELEGRAM_BASE || 'https://api.telegram.org';

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram ${code}: ${description}`);
    this.name = 'TelegramError';
  }
}

async function call<T>(
  token: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(`${TELEGRAM_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: combined,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
  };

  if (!payload.ok) {
    throw new TelegramError(payload.error_code ?? response.status, payload.description ?? 'unknown');
  }
  return payload.result as T;
}

export function getMe(token: string): Promise<{ id: number; username?: string; first_name?: string }> {
  return call(token, 'getMe', undefined, undefined, 15_000);
}

/**
 * Long-polls for updates. `timeoutSeconds` is server-side: the request hangs
 * until something arrives or the timeout expires, so this is cheap to loop on.
 */
export function getUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  return call(
    token,
    'getUpdates',
    { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
    signal,
    // Outlive the server-side hold, or every poll would abort just before
    // returning and updates would be fetched twice.
    (timeoutSeconds + 15) * 1000,
  );
}

/** Telegram rejects messages over 4096 characters, so long posts are split. */
export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    // Prefer a paragraph break, then a line break, then a hard cut.
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const part of splitMessage(text)) {
    try {
      await call(
        token,
        'sendMessage',
        {
          chat_id: chatId,
          text: part,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
        signal,
      );
    } catch (err) {
      // A malformed entity is the usual cause; retry once as plain text rather
      // than dropping the message entirely.
      if (err instanceof TelegramError && /can't parse entities/i.test(err.description)) {
        await call(
          token,
          'sendMessage',
          { chat_id: chatId, text: stripHtml(part), link_preview_options: { is_disabled: true } },
          signal,
        );
      } else {
        log.warn(`sendMessage failed: ${(err as Error).message}`);
        throw err;
      }
    }
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

/** Escapes text for Telegram's HTML parse mode. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
