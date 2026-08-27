/**
 * Minimal Server-Sent Events reader over a fetch Response body.
 *
 * Every provider here streams SSE, but they disagree on the details: OpenAI and
 * GLM send bare `data:` lines terminated by `[DONE]`, while Anthropic uses named
 * `event:` types. This parser surfaces both, and tolerates chunk boundaries
 * landing anywhere — including in the middle of a multi-byte UTF-8 sequence.
 */

export interface SseMessage {
  event: string;
  data: string;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  // `stream: true` keeps partial code points buffered instead of emitting U+FFFD.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; \r\n is legal too.
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseEvent(rawEvent);
        if (parsed) yield parsed;
        boundary = findBoundary(buffer);
      }
    }

    // Flush a trailing event that arrived without its terminating blank line.
    buffer += decoder.decode();
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEvent(raw: string): SseMessage | null {
  if (!raw.trim()) return null;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single optional space after the colon is part of the framing.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Reads newline-delimited JSON, the format the `claude` and `codex` CLIs use.
 * Malformed lines are skipped: CLIs occasionally interleave human-readable
 * warnings with their JSON stream.
 */
export async function* readJsonLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* not JSON — CLI chatter */
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      /* ignore */
    }
  }
}
