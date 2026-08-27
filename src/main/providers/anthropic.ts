import type { ChatRequest, ConnectionTestResult, ModelInfo } from '@shared/types';
import { hostOf, request } from '../net/http';
import { readSse } from '../net/sse';
import { resolveApiKey } from '../store/secrets';
import { loadSettings, resolveBaseUrl } from '../store/settings';
import { createLogger } from '../util/logger';
import { MissingCredentialsError, type ProviderAdapter, type ProviderContext } from './types';
import { failure } from './glm';

const log = createLogger('provider:anthropic');

const API_VERSION = '2023-06-01';

/**
 * Anthropic Messages API over SSE.
 *
 * Note on subscriptions: a Claude Pro/Max login is *not* usable here. Those
 * credentials belong to the Claude Code CLI, and this app deliberately never
 * touches them — pick the `cli` transport instead and Claude Code does the
 * talking. This adapter is the API-key path only.
 */
export class AnthropicProvider implements ProviderAdapter {
  private auth(): { headers: Record<string, string>; baseUrl: string } {
    const resolved = resolveApiKey('anthropic');
    if (!resolved) {
      throw new MissingCredentialsError(
        'Add an Anthropic API key in Settings → Providers → Claude, or switch that provider to the "Claude Code CLI" transport to use a Pro/Max subscription.',
      );
    }
    const settings = loadSettings();
    return {
      baseUrl: resolveBaseUrl('anthropic', settings),
      headers: {
        'x-api-key': resolved.key,
        'anthropic-version': API_VERSION,
        ...(settings.providers.anthropic.headers ?? {}),
      },
    };
  }

  async stream(req: ChatRequest, ctx: ProviderContext): Promise<void> {
    const { baseUrl, headers } = this.auth();

    // Anthropic takes the system prompt as a top-level field, not a message.
    const messages = req.messages
      .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const maxTokens = req.maxTokens ?? 4096;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };
    if (req.systemPrompt?.trim()) body.system = req.systemPrompt.trim();

    if (req.thinking) {
      // Extended thinking needs headroom inside max_tokens and forbids a
      // temperature override, so both are set together or not at all.
      const budget = Math.max(1024, Math.floor(maxTokens * 0.5));
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(maxTokens, budget + 1024);
    } else if (typeof req.temperature === 'number') {
      body.temperature = req.temperature;
    }

    log.debug(`streaming ${req.model} from ${hostOf(baseUrl)}`);

    const response = await request(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: ctx.signal,
    });
    if (!response.body) throw new Error('Anthropic returned an empty response body.');

    for await (const message of readSse(response.body, ctx.signal)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'message_start':
          if (event.message?.usage) {
            ctx.emit({
              type: 'usage',
              streamId: ctx.streamId,
              inputTokens: event.message.usage.input_tokens,
              outputTokens: event.message.usage.output_tokens,
            });
          }
          break;

        case 'content_block_delta': {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            ctx.emit({ type: 'text', streamId: ctx.streamId, text: delta.text });
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            ctx.emit({ type: 'reasoning', streamId: ctx.streamId, text: delta.thinking });
          }
          break;
        }

        case 'message_delta':
          if (event.usage?.output_tokens !== undefined) {
            ctx.emit({
              type: 'usage',
              streamId: ctx.streamId,
              outputTokens: event.usage.output_tokens,
            });
          }
          break;

        case 'error':
          throw new Error(event.error?.message ?? 'Anthropic reported a stream error.');

        default:
          break;
      }
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const { baseUrl, headers } = this.auth();
      const model = loadSettings().providers.anthropic.defaultModel;
      await request(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        timeoutMs: 30_000,
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        model,
        message: `Connected to ${hostOf(baseUrl)} as ${model}.`,
      };
    } catch (err) {
      return failure(err);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const { baseUrl, headers } = this.auth();
    const response = await request(`${baseUrl}/v1/models?limit=100`, {
      headers,
      timeoutMs: 20_000,
    });
    const payload = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string }>;
    };
    return (payload.data ?? []).map((entry) => ({
      id: entry.id,
      provider: 'anthropic' as const,
      label: entry.display_name ?? entry.id,
    }));
  }
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; thinking?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}
