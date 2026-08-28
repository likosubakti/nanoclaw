import { createLogger } from '../util/logger';

const log = createLogger('http');

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }

  /**
   * Turns a vendor error body into something a user can act on. All three
   * providers return JSON with the message in a different place.
   */
  get friendly(): { message: string; hint?: string } {
    const parsed = tryParse(this.body);
    const vendorMessage =
      parsed?.error?.message ??
      parsed?.error?.msg ??
      parsed?.message ??
      parsed?.msg ??
      (this.body.length < 400 ? this.body : '');

    switch (this.status) {
      case 401:
        return {
          message: vendorMessage || 'Authentication failed.',
          hint: 'The API key was rejected. Check it in Settings → Providers, and make sure it belongs to the endpoint you selected.',
        };
      case 403:
        return {
          message: vendorMessage || 'Access denied.',
          hint: 'The key is valid but not entitled to this model or endpoint. Coding Plan keys only work on the Coding endpoint.',
        };
      case 404:
        return {
          message: vendorMessage || 'Endpoint or model not found.',
          hint: 'Check the model id and the base URL in Settings → Providers.',
        };
      case 429:
        return {
          message: vendorMessage || 'Rate limited.',
          hint: 'Too many requests, or the plan quota is exhausted. Wait and retry.',
        };
      default:
        if (this.status >= 500) {
          return {
            message: vendorMessage || 'The provider returned a server error.',
            hint: 'This is upstream — retrying usually works.',
          };
        }
        return { message: vendorMessage || `Request failed with HTTP ${this.status}.` };
    }
  }
}

function tryParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * fetch with a timeout, structured errors, and no retry. Retrying a streaming
 * completion silently would double-bill the user, so callers decide.
 *
 * The deadline covers reaching the server, not the exchange. `AbortSignal.timeout`
 * keeps running once the headers arrive and tears the body stream mid-read, so
 * a whole-exchange deadline killed any answer that took longer than it — and,
 * because the abort came from the timer rather than the caller's signal, it
 * surfaced as a bare DOMException and the partial answer, already paid for, was
 * dropped from the transcript. A streaming body is governed by the caller's
 * signal alone; that is what the Stop button is.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 120_000 } = options;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: body ? 'text/event-stream, application/json' : 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.signal.aborted) {
      throw new Error(
        `Request to ${hostOf(url)} timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    throw new Error(`Could not reach ${hostOf(url)}: ${(err as Error).message}`);
  } finally {
    // The headers are in. Anything still to come is the model thinking, and
    // that is the caller's signal to govern, not a stopwatch's.
    clearTimeout(timer);
  }

  log.debug(`${method} ${hostOf(url)} → ${response.status} in ${Date.now() - started}ms`);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new HttpError(response.status, text, url);
  }
  return response;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Redacts credentials before a header map reaches a log line. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /authorization|api-key|token|secret/i.test(key) ? '«redacted»' : value;
  }
  return out;
}
