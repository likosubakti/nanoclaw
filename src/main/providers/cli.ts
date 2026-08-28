import { spawn } from 'node:child_process';
import type { ChatRequest, ConnectionTestResult, ProviderId } from '@shared/types';
import { PROVIDER_CLI } from '@shared/models';
import { readJsonLines } from '../net/sse';
import { buildCliEnv } from '../agents/env';
import { CLI_INSTALL_HINT, detectCli, probeCapabilities } from '../agents/cli-detect';
import { claudeArgs, discussionSystemPrompt } from './cli-args';
import { createClaudeParser, createCodexParser } from './cli-stream';
import { cliSessionState } from '../auth/cli-credentials';
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
    const status = await detectCli(this.provider, await cliSessionState(this.provider));
    if (!status.installed) {
      throw new MissingCredentialsError(
        `${PROVIDER_CLI[this.provider].label} is not installed. Install it with:\n  ${CLI_INSTALL_HINT[this.provider]}`,
      );
    }

    // Without a Z.ai key there is nothing pointing this child at GLM, so it
    // would quietly answer as Claude — on the user's Anthropic subscription,
    // under a seat labelled GLM. Better to refuse than to mislabel an answer.
    if (this.provider === 'glm') {
      const { resolveApiKey } = await import('../store/secrets');
      if (!resolveApiKey('glm')) {
        throw new MissingCredentialsError(
          'Claude Code has no Z.ai key to use, so it would answer as Claude instead of GLM.\nAdd your GLM API key in Settings → Providers → GLM.',
        );
      }
    }

    const prompt = lastUserMessage(req);
    if (!prompt) throw new Error('Nothing to send: the last message is empty.');

    const isCodex = PROVIDER_CLI[this.provider].command === 'codex';
    const capabilities = await probeCapabilities(status.path!);
    const args = isCodex ? codexArgs(req) : claudeArgs(req, capabilities);

    log.debug(`spawning ${status.path} ${args.join(' ')}`);

    // detectCli, probeCapabilities and cliSessionState above all exec the
    // binary, which takes about a second. A listener added to an already
    // aborted signal never fires, so spawning now would leave a child nobody
    // kills — running a full billed turn after the user pressed Stop.
    if (ctx.signal.aborted) return;

    const child = spawn(status.path!, args, {
      cwd: req.cwd || loadSettings().workspaceDir,
      env: buildCliEnv(this.provider),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // SIGTERM first, then SIGKILL if it is ignored. Until the child is gone
    // the round holds its lock, so a CLI that declines to die would strand the
    // room — and keep billing the user's subscription while it does.
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    };
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
    const system = req.systemPrompt?.trim();
    // Codex has no flag to replace its system prompt, so a discussion turn
    // carries its framing — and the caller's, which names the seat, its role,
    // the topic and who else is in the room — in the prompt itself. Dropping
    // the caller's half leaves a seat that does not know which speaker it is.
    const framed =
      isCodex && policy !== 'full'
        ? `${discussionSystemPrompt(system, policy)}\n\n---\n\n${prompt}`
        : isCodex && system
          ? `${system}\n\n---\n\n${prompt}`
          : prompt;
    child.stdin.write(framed);
    child.stdin.end();

    try {
      const parse = isCodex ? createCodexParser(ctx.streamId) : createClaudeParser(ctx.streamId);
      for await (const event of readJsonLines(child.stdout)) {
        for (const emitted of parse(event)) ctx.emit(emitted);
      }
      // A build without --include-partial-messages streams no deltas; this is
      // where its reply finally gets emitted.
      for (const emitted of parse.finish()) ctx.emit(emitted);

      const code = await exited;
      if (code !== 0 && code !== null) {
        throw new Error(cliFailureMessage(this.provider, code, stderr));
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (!child.killed) child.kill();
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const credentials = await cliSessionState(this.provider);
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

/* ------------------------------------------------------------- helpers ---- */

function lastUserMessage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') return req.messages[i].content;
  }
  return '';
}

function cliFailureMessage(provider: ProviderId, code: number, stderr: string): string {
  const label = PROVIDER_CLI[provider].label;
  const tail = stderr.trim().split('\n').slice(-6).join('\n');

  if (/not logged in|unauthor|authentication|login/i.test(stderr)) {
    return `${label} is not signed in.\nRun \`${PROVIDER_CLI[provider].command} login\` or use the Login screen.\n\n${tail}`;
  }
  return `${label} exited with code ${code}.${tail ? `\n\n${tail}` : ''}`;
}
