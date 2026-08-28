import { spawn } from 'node:child_process';
import type { ChatRequest, ConnectionTestResult, ProviderId } from '@shared/types';
import { PROVIDER_CLI } from '@shared/models';
import { readJsonLines } from '../net/sse';
import { buildCliEnv } from '../agents/env';
import { CLI_INSTALL_HINT, detectCli, probeCapabilities } from '../agents/cli-detect';
import { claudeArgs, discussionSystemPrompt } from './cli-args';
import { readCliCredentials } from '../auth/cli-credentials';
import { loadSettings } from '../store/settings';
import { createLogger } from '../util/logger';
import { MissingCredentialsError, type ProviderAdapter, type ProviderContext } from './types';

const log = createLogger('provider:cli');

/**
 * Runs a turn through the vendor's own agent CLI instead of its HTTP API.
 *
 * This is what makes subscription plans work. A Claude Pro/Max or ChatGPT
 * Plus/Pro login lives inside `claude` / `codex`; those credentials are not
 * valid bearer tokens for the public APIs and this app never reads them.
 * Handing the prompt to the CLI keeps the login entirely in the tool that owns
 * it, and has the side benefit that the agent's tools work too.
 */
export class CliProvider implements ProviderAdapter {
  constructor(private readonly provider: ProviderId) {}

  async stream(req: ChatRequest, ctx: ProviderContext): Promise<void> {
    const status = await detectCli(this.provider, readCliCredentials(this.provider));
    if (!status.installed) {
      throw new MissingCredentialsError(
        `${PROVIDER_CLI[this.provider].label} is not installed. Install it with:\n  ${CLI_INSTALL_HINT[this.provider]}`,
      );
    }

    const prompt = lastUserMessage(req);
    if (!prompt) throw new Error('Nothing to send: the last message is empty.');

    const isCodex = PROVIDER_CLI[this.provider].command === 'codex';
    const capabilities = await probeCapabilities(status.path!);
    const args = isCodex ? codexArgs(req) : claudeArgs(req, capabilities);

    log.debug(`spawning ${status.path} ${args.join(' ')}`);

    const child = spawn(status.path!, args, {
      cwd: req.cwd || loadSettings().workspaceDir,
      env: buildCliEnv(this.provider),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail: a chatty CLI can emit megabytes of progress noise.
      stderr = (stderr + chunk).slice(-4000);
    });

    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    // The prompt goes over stdin so it never appears in the process table.
    // Codex has no flag to replace its system prompt, so a discussion turn
    // carries its framing in the prompt itself.
    const policy = req.toolPolicy ?? 'full';
    const framed =
      isCodex && policy !== 'full'
        ? `${discussionSystemPrompt(undefined, policy)}\n\n---\n\n${prompt}`
        : prompt;
    child.stdin.write(framed);
    child.stdin.end();

    try {
      const parse = isCodex ? parseCodexEvent : parseClaudeEvent;
      for await (const event of readJsonLines(child.stdout)) {
        for (const emitted of parse(event, ctx.streamId)) ctx.emit(emitted);
      }

      const code = await exited;
      if (code !== 0 && code !== null) {
        throw new Error(cliFailureMessage(this.provider, code, stderr));
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill();
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const credentials = readCliCredentials(this.provider);
    const status = await detectCli(this.provider, credentials);
    const label = PROVIDER_CLI[this.provider].label;

    if (!status.installed) {
      return {
        ok: false,
        message: `${label} is not installed.`,
        hint: `Install it with:  ${CLI_INSTALL_HINT[this.provider]}`,
      };
    }

    // GLM through Claude Code needs a key; the other two can ride a session.
    if (this.provider === 'glm') {
      const { resolveApiKey } = await import('../store/secrets');
      if (!resolveApiKey('glm')) {
        return {
          ok: false,
          message: 'Claude Code is installed but has no Z.ai key to use.',
          hint: 'Add your GLM API key in Settings → Providers → GLM.',
        };
      }
    } else if (!credentials.loggedIn) {
      const { resolveApiKey } = await import('../store/secrets');
      if (!resolveApiKey(this.provider)) {
        return {
          ok: false,
          message: `${label} is installed but not signed in.`,
          hint: `Click "Sign in" on the Login screen, or run \`${status.command} login\` in a terminal.`,
        };
      }
    }

    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `${label} ready${status.version ? ` (${status.version})` : ''}${
        credentials.accountHint ? ` — ${credentials.accountHint}` : ''
      }.`,
    };
  }
}

/* --------------------------------------------------------- argument sets -- */

function codexArgs(req: ChatRequest): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (req.model) args.push('--model', req.model);
  // Read the prompt from stdin.
  args.push('-');
  return args;
}

/* ------------------------------------------------------------- parsers ---- */

type Emit = Parameters<ProviderContext['emit']>[0];

/**
 * Claude Code stream-json. Partial deltas arrive as `stream_event`; whole
 * assistant turns arrive as `assistant`. Both are handled because
 * --include-partial-messages is only supported on newer releases, and an older
 * CLI silently ignores the flag rather than failing.
 */
function parseClaudeEvent(event: unknown, streamId: string): Emit[] {
  const out: Emit[] = [];
  if (!event || typeof event !== 'object') return out;
  const e = event as any;

  if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
    out.push({ type: 'session', streamId, sessionId: e.session_id });
    return out;
  }

  if (e.type === 'stream_event' && e.event?.type === 'content_block_delta') {
    const delta = e.event.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      out.push({ type: 'text', streamId, text: delta.text });
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
      out.push({ type: 'reasoning', streamId, text: delta.thinking });
    }
    return out;
  }

  // Fall back to whole messages only when partial streaming is unavailable.
  if (e.type === 'assistant' && Array.isArray(e.message?.content) && !e.__partialSeen) {
    for (const block of e.message.content) {
      if (block.type === 'tool_use') {
        out.push({ type: 'tool', streamId, ...describeTool(block.name, block.input) });
      }
    }
    return out;
  }

  if (e.type === 'result') {
    if (e.session_id) out.push({ type: 'session', streamId, sessionId: e.session_id });
    if (e.usage) {
      out.push({
        type: 'usage',
        streamId,
        inputTokens: e.usage.input_tokens,
        outputTokens: e.usage.output_tokens,
      });
    }
    if (e.is_error && e.result) {
      out.push({ type: 'error', streamId, message: String(e.result) });
    }
  }

  return out;
}

/**
 * Codex has changed its JSON envelope across releases. Rather than pin to one
 * version, look for every shape it has used: `msg.type` deltas (0.x), and
 * `item.completed` items (newer).
 */
function parseCodexEvent(event: unknown, streamId: string): Emit[] {
  const out: Emit[] = [];
  if (!event || typeof event !== 'object') return out;
  const e = event as any;

  const msg = e.msg ?? e;
  switch (msg.type) {
    case 'agent_message_delta':
      if (msg.delta) out.push({ type: 'text', streamId, text: msg.delta });
      return out;
    case 'agent_reasoning_delta':
    case 'agent_reasoning_raw_content_delta':
      if (msg.delta) out.push({ type: 'reasoning', streamId, text: msg.delta });
      return out;
    case 'exec_command_begin':
      out.push({
        type: 'tool',
        streamId,
        name: 'shell',
        detail: Array.isArray(msg.command) ? msg.command.join(' ') : summarise(msg.command),
      });
      return out;
    case 'web_search_begin':
    case 'web_search_call':
      out.push({
        type: 'tool',
        streamId,
        name: 'WebSearch',
        query: typeof msg.query === 'string' ? msg.query : undefined,
        detail: typeof msg.query === 'string' ? msg.query : summarise(msg.query),
      });
      return out;
    case 'token_count':
      out.push({
        type: 'usage',
        streamId,
        inputTokens: msg.info?.total_token_usage?.input_tokens,
        outputTokens: msg.info?.total_token_usage?.output_tokens,
      });
      return out;
    case 'error':
      out.push({ type: 'error', streamId, message: msg.message ?? 'Codex reported an error.' });
      return out;
    default:
      break;
  }

  if (e.type === 'item.completed' && e.item) {
    if (e.item.type === 'agent_message' && e.item.text) {
      out.push({ type: 'text', streamId, text: e.item.text });
    } else if (e.item.type === 'command_execution') {
      out.push({ type: 'tool', streamId, name: 'shell', detail: e.item.command });
    } else if (e.item.type === 'web_search') {
      out.push({ type: 'tool', streamId, name: 'WebSearch', query: e.item.query, detail: e.item.query });
    }
    return out;
  }

  if (e.type === 'thread.started' && e.thread_id) {
    out.push({ type: 'session', streamId, sessionId: e.thread_id });
  }
  return out;
}

/* ------------------------------------------------------------- helpers ---- */

function lastUserMessage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') return req.messages[i].content;
  }
  return '';
}

/**
 * Turns a Claude Code tool_use into a research-trail entry.
 *
 * The point is the structured fields: a WebSearch's terms and a WebFetch's URL
 * are what make the trail readable ("searched X", "read Y") instead of a wall
 * of JSON, and the URL becomes a link the user can follow.
 */
function describeTool(
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

function summarise(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function cliFailureMessage(provider: ProviderId, code: number, stderr: string): string {
  const label = PROVIDER_CLI[provider].label;
  const tail = stderr.trim().split('\n').slice(-6).join('\n');

  if (/not logged in|unauthor|authentication|login/i.test(stderr)) {
    return `${label} is not signed in.\nRun \`${PROVIDER_CLI[provider].command} login\` or use the Login screen.\n\n${tail}`;
  }
  return `${label} exited with code ${code}.${tail ? `\n\n${tail}` : ''}`;
}
