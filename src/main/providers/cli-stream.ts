import type { StreamEvent } from '@shared/types';

/**
 * Parsers for the JSON-lines both agent CLIs emit.
 *
 * They live apart from `cli.ts` for two reasons: they are the part most likely
 * to break when a CLI changes its envelope, and keeping them free of Electron
 * imports means that breakage can be caught by a test instead of by a user
 * watching an empty reply.
 *
 * Each parser is created per stream because it has to remember one thing:
 * whether token-level deltas arrived. Both CLIs also emit the finished message,
 * so without that memory a stream either duplicates every reply or — when the
 * partial-message flag is unsupported — produces nothing at all.
 */

export type Emit = StreamEvent;

export type StreamParser = {
  (event: unknown): Emit[];
  /** Emits a last-resort reply if the stream ended without producing text. */
  finish(): Emit[];
};

function makeParser(
  step: (event: any, streamId: string, state: State) => Emit[],
  streamId: string,
): StreamParser {
  const state: State = { sawDelta: false, sawText: false, fallback: undefined };
  const parser = ((event: unknown) => {
    if (!event || typeof event !== 'object') return [];
    const out = step(event, streamId, state);
    for (const emitted of out) if (emitted.type === 'text') state.sawText = true;
    return out;
  }) as StreamParser;
  parser.finish = () => {
    if (state.sawText || !state.fallback) return [];
    return [{ type: 'text', streamId, text: state.fallback }];
  };
  return parser;
}

interface State {
  /** Token-level deltas arrived, so the whole message would be a duplicate. */
  sawDelta: boolean;
  sawText: boolean;
  /** The final text the CLI reported, used only if nothing else produced any. */
  fallback?: string;
}

/* --------------------------------------------------------------- claude -- */

/**
 * Claude Code `--output-format stream-json`.
 *
 * `--include-partial-messages` only exists on newer releases, so a build
 * without it emits whole `assistant` messages and no deltas at all. That path
 * has to produce the reply, or a working subscription looks like a silent
 * failure.
 */
export function createClaudeParser(streamId: string): StreamParser {
  return makeParser((e, id, state) => {
    const out: Emit[] = [];

    if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
      out.push({ type: 'session', streamId: id, sessionId: e.session_id });
      return out;
    }

    if (e.type === 'stream_event' && e.event?.type === 'content_block_delta') {
      const delta = e.event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        state.sawDelta = true;
        out.push({ type: 'text', streamId: id, text: delta.text });
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        out.push({ type: 'reasoning', streamId: id, text: delta.thinking });
      }
      return out;
    }

    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === 'tool_use') {
          // Never duplicated: deltas carry text and thinking, never tool calls.
          out.push({ type: 'tool', streamId: id, ...describeTool(block.name, block.input) });
        } else if (block?.type === 'text' && block.text && !state.sawDelta) {
          out.push({ type: 'text', streamId: id, text: block.text });
        } else if (block?.type === 'thinking' && block.thinking && !state.sawDelta) {
          out.push({ type: 'reasoning', streamId: id, text: block.thinking });
        }
      }
      return out;
    }

    if (e.type === 'result') {
      if (e.session_id) out.push({ type: 'session', streamId: id, sessionId: e.session_id });
      if (e.usage) {
        out.push({
          type: 'usage',
          streamId: id,
          // Cache tokens are the overwhelming majority for a CLI seat: a turn
          // carrying a full system prompt measures input_tokens 2 against
          // cache_creation_input_tokens 38,732, and a resumed seat pays the
          // same again as cache_read. Counting only the first made the header's
          // token total — the thing that makes unbounded spend visible — wrong
          // by orders of magnitude.
          inputTokens: sum(
            e.usage.input_tokens,
            e.usage.cache_creation_input_tokens,
            e.usage.cache_read_input_tokens,
          ),
          outputTokens: sum(e.usage.output_tokens),
        });
      }
      if (e.is_error && e.result) {
        out.push({ type: 'error', streamId: id, message: String(e.result) });
      } else if (typeof e.result === 'string' && e.result) {
        // Held back rather than emitted: it repeats the reply on every build
        // that streamed one. It is used only if nothing else produced text.
        state.fallback = e.result;
      }
    }

    return out;
  }, streamId);
}

/* ---------------------------------------------------------------- codex -- */

/**
 * Codex has changed its envelope across releases, so every shape it has used is
 * accepted: `msg.type` deltas (0.x) and `item.completed` items (newer). A
 * release that emits both would otherwise print each reply twice.
 */
export function createCodexParser(streamId: string): StreamParser {
  return makeParser((e, id, state) => {
    const out: Emit[] = [];
    const msg = e.msg ?? e;

    switch (msg.type) {
      case 'agent_message_delta':
        if (msg.delta) {
          state.sawDelta = true;
          out.push({ type: 'text', streamId: id, text: msg.delta });
        }
        return out;
      case 'agent_reasoning_delta':
      case 'agent_reasoning_raw_content_delta':
        if (msg.delta) out.push({ type: 'reasoning', streamId: id, text: msg.delta });
        return out;
      case 'agent_message':
        // The whole reply, in the 0.x envelope.
        if (!state.sawDelta && (msg.message ?? msg.text)) {
          out.push({ type: 'text', streamId: id, text: String(msg.message ?? msg.text) });
        }
        return out;
      case 'exec_command_begin':
        out.push({
          type: 'tool',
          streamId: id,
          name: 'shell',
          detail: Array.isArray(msg.command) ? msg.command.join(' ') : summarise(msg.command),
        });
        return out;
      case 'web_search_begin':
      case 'web_search_call':
        out.push({
          type: 'tool',
          streamId: id,
          name: 'WebSearch',
          query: typeof msg.query === 'string' ? msg.query : undefined,
          detail: typeof msg.query === 'string' ? msg.query : summarise(msg.query),
        });
        return out;
      case 'token_count':
        out.push({
          type: 'usage',
          streamId: id,
          inputTokens: sum(msg.info?.total_token_usage?.input_tokens),
          outputTokens: sum(msg.info?.total_token_usage?.output_tokens),
        });
        return out;
      case 'error':
        out.push({ type: 'error', streamId: id, message: msg.message ?? 'Codex reported an error.' });
        return out;
      default:
        break;
    }

    // Newer codex reports usage here instead of in a `token_count` message.
    // Without this case a Codex seat contributed zero to the room's total.
    // `cached_input_tokens` is a subset of `input_tokens`, not an addition.
    if (e.type === 'turn.completed' && e.usage) {
      out.push({
        type: 'usage',
        streamId: id,
        inputTokens: sum(e.usage.input_tokens),
        outputTokens: sum(e.usage.output_tokens),
      });
      return out;
    }

    if (e.type === 'item.completed' && e.item) {
      if (e.item.type === 'agent_message' && e.item.text) {
        if (!state.sawDelta) out.push({ type: 'text', streamId: id, text: e.item.text });
      } else if (e.item.type === 'command_execution') {
        out.push({ type: 'tool', streamId: id, name: 'shell', detail: e.item.command });
      } else if (e.item.type === 'web_search') {
        out.push({
          type: 'tool',
          streamId: id,
          name: 'WebSearch',
          query: e.item.query,
          detail: e.item.query,
        });
      }
      return out;
    }

    if (e.type === 'thread.started' && e.thread_id) {
      out.push({ type: 'session', streamId: id, sessionId: e.thread_id });
    }
    return out;
  }, streamId);
}

/* ------------------------------------------------------------- helpers ---- */

/**
 * Turns a Claude Code tool_use into a research-trail entry.
 *
 * The point is the structured fields: a WebSearch's terms and a WebFetch's URL
 * are what make the trail readable ("searched X", "read Y") instead of a wall
 * of JSON, and the URL becomes a link the user can follow.
 */
export function describeTool(
  name: string,
  input: any,
): { name: string; detail?: string; query?: string; url?: string } {
  const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

  switch (name) {
    case 'WebSearch': {
      const query = asString(input?.query);
      return { name, query, detail: query };
    }
    case 'WebFetch': {
      const url = asString(input?.url);
      const prompt = asString(input?.prompt);
      return { name, url, detail: prompt ? `${url} — ${prompt}` : url };
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return { name, detail: asString(input?.file_path) ?? summarise(input) };
    case 'Bash':
      return { name, detail: asString(input?.command) ?? summarise(input) };
    case 'Grep':
    case 'Glob':
      return { name, detail: asString(input?.pattern) ?? summarise(input) };
    case 'Task':
      return { name, detail: asString(input?.description) ?? summarise(input) };
    default:
      return { name, detail: summarise(input) };
  }
}

/** Adds the numeric fields a usage payload actually carried. */
function sum(...values: unknown[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

export function summarise(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
