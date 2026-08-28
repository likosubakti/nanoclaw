import { randomUUID } from 'node:crypto';
import type {
  ChatRequest,
  ConnectionTestResult,
  ModelInfo,
  ProviderId,
  StreamEvent,
  Transport,
} from '@shared/types';
import { HttpError } from '../net/http';
import { createLogger } from '../util/logger';
import { AnthropicProvider } from './anthropic';
import { CliProvider } from './cli';
import { GlmProvider } from './glm';
import { KimiProvider } from './kimi';
import { OpenAiProvider } from './openai';
import { MissingCredentialsError, type ProviderAdapter } from './types';

const log = createLogger('registry');

const apiAdapters: Record<ProviderId, ProviderAdapter> = {
  glm: new GlmProvider(),
  anthropic: new AnthropicProvider(),
  openai: new OpenAiProvider(),
  kimi: new KimiProvider(),
};

const cliAdapters: Record<ProviderId, ProviderAdapter> = {
  glm: new CliProvider('glm'),
  anthropic: new CliProvider('anthropic'),
  openai: new CliProvider('openai'),
  kimi: new CliProvider('kimi'),
};

export function adapterFor(provider: ProviderId, transport: Transport): ProviderAdapter {
  const adapter = transport === 'cli' ? cliAdapters[provider] : apiAdapters[provider];
  // Defence in depth. Inputs are validated at the IPC boundary, but a stored
  // room written by an older build could still name a provider we dropped, and
  // "cannot read properties of undefined" is a useless thing to show a user.
  if (!adapter) {
    throw new Error(`No adapter for provider "${provider}" over "${transport}".`);
  }
  return adapter;
}

/* ---------------------------------------------------------- streaming ----- */

const active = new Map<string, AbortController>();

/**
 * Runs one turn and pushes events to `emit`. Resolves when the turn is over,
 * whether it succeeded, failed, or was aborted — the caller does not need to
 * distinguish, because the outcome is already on the event stream.
 */
export async function runChat(
  request: ChatRequest,
  emit: (event: StreamEvent) => void,
): Promise<string> {
  const streamId = randomUUID();
  const controller = new AbortController();
  active.set(streamId, controller);

  const started = Date.now();
  emit({ type: 'start', streamId });

  try {
    const adapter = adapterFor(request.provider, request.transport);
    await adapter.stream(request, { streamId, signal: controller.signal, emit });
    // Cancelling a fetch body makes the reader finish cleanly rather than
    // throw, so an aborted turn arrives here, not in the catch below. Without
    // this check the UI would present a truncated answer as a complete one.
    emit({
      type: 'done',
      streamId,
      finishReason: controller.signal.aborted ? 'aborted' : undefined,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      emit({ type: 'done', streamId, finishReason: 'aborted', durationMs: Date.now() - started });
    } else {
      const { message, hint } = describeError(err);
      log.warn(`stream ${streamId} failed: ${message}`);
      emit({ type: 'error', streamId, message, hint });
    }
  } finally {
    active.delete(streamId);
  }

  return streamId;
}

export function abortChat(streamId: string): boolean {
  const controller = active.get(streamId);
  if (!controller) return false;
  controller.abort();
  active.delete(streamId);
  return true;
}

export function abortAll(): void {
  for (const controller of active.values()) controller.abort();
  active.clear();
}

function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof MissingCredentialsError) {
    return { message: 'No credentials configured for this provider.', hint: err.hint };
  }
  if (err instanceof HttpError) return err.friendly;
  const message = (err as Error)?.message ?? String(err);

  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(message)) {
    return {
      message: 'Could not reach the provider.',
      hint: 'Check your network connection, and any proxy settings, then try again.',
    };
  }
  if (/ENOENT/.test(message)) {
    return {
      message: 'The command could not be started.',
      hint: 'The CLI for this provider is not installed, or its path in Settings is wrong.',
    };
  }
  return { message };
}

/* ------------------------------------------------------------- helpers ---- */

export async function testProvider(
  provider: ProviderId,
  transport: Transport,
): Promise<ConnectionTestResult> {
  try {
    return await adapterFor(provider, transport).test();
  } catch (err) {
    const { message, hint } = describeError(err);
    return { ok: false, message, hint };
  }
}

export async function refreshModels(provider: ProviderId): Promise<ModelInfo[]> {
  const adapter = apiAdapters[provider];
  if (!adapter.listModels) return [];
  return adapter.listModels();
}
