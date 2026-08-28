import type { ChatRequest, ConnectionTestResult, ModelInfo } from '@shared/types';
import { hostOf, request } from '../net/http';
import { readSse } from '../net/sse';
import { resolveApiKey } from '../store/secrets';
import { loadSettings, resolveBaseUrl } from '../store/settings';
import { createLogger } from '../util/logger';
import { buildMessages, failure } from './glm';
import { MissingCredentialsError, type ProviderAdapter, type ProviderContext } from './types';

const log = createLogger('provider:kimi');

/**
 * Kimi (Moonshot AI).
 *
 * The wire shape is the same as GLM's, which is not a coincidence worth
 * glossing over: Moonshot's own client is a thin wrapper over the OpenAI SDK,
 * it switches reasoning on with `thinking: { type: "enabled" }` in the request
 * body, and it reads the chain of thought back from `reasoning_content`
 * alongside `content`. So this adapter is deliberately GLM's, minus the Zhipu
 * JWT — Kimi keys are bearer tokens as issued.
 *
 * The three endpoints are the same split as GLM's, for the same reason: the
 * .ai and .cn platforms are separate products with separate accounts, and the
 * subscription surface is a third endpoint again.
 */
export class KimiProvider implements ProviderAdapter {
  private auth(): { headers: Record<string, string>; baseUrl: string } {
    const resolved = resolveApiKey('kimi');
    if (!resolved) {
      throw new MissingCredentialsError(
        'Add a Moonshot API key in Settings → Providers → Kimi, or switch this provider to the Kimi Code CLI to use your subscription.',
      );
    }
    const settings = loadSettings();
    return {
      baseUrl: resolveBaseUrl('kimi', settings),
      headers: {
        authorization: `Bearer ${resolved.key}`,
        ...(settings.providers.kimi.headers ?? {}),
      },
    };
  }

  async stream(req: ChatRequest, ctx: ProviderContext): Promise<void> {
    const { baseUrl, headers } = this.auth();
    const model = req.model;

    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: buildMessages(req),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };
    // Only when asked: a model that does not support the switch rejects it, and
    // the always-thinking variants do not need it.
    if (req.thinking) body.thinking = { type: 'enabled' };

    log.debug(`streaming ${model} from ${hostOf(baseUrl)}`);

    const response = await request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: ctx.signal,
    });

    if (!response.body) throw new Error('Kimi returned an empty response body.');

    for await (const message of readSse(response.body, ctx.signal)) {
      if (message.data === '[DONE]') break;

      let chunk: KimiChunk;
      try {
        chunk = JSON.parse(message.data);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        ctx.emit({ type: 'reasoning', streamId: ctx.streamId, text: delta.reasoning_content });
      }
      if (delta?.content) {
        ctx.emit({ type: 'text', streamId: ctx.streamId, text: delta.content });
      }
      if (chunk.usage) {
        ctx.emit({
          type: 'usage',
          streamId: ctx.streamId,
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        });
      }
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const { baseUrl, headers } = this.auth();
      const model = loadSettings().providers.kimi.defaultModel || 'kimi-k2.6';
      await request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
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

  /**
   * The seeded catalog carries only ids confirmed from Moonshot's own client,
   * and no context windows. This is how the picker gets the real list.
   */
  async listModels(): Promise<ModelInfo[]> {
    const { baseUrl, headers } = this.auth();
    const response = await request(`${baseUrl}/models`, { headers, timeoutMs: 20_000 });
    const payload = (await response.json()) as {
      data?: Array<{ id: string; context_length?: number; supports_reasoning?: boolean; display_name?: string }>;
    };
    return (payload.data ?? []).map((entry) => ({
      id: entry.id,
      provider: 'kimi' as const,
      label: entry.display_name || entry.id,
      contextWindow: entry.context_length,
      supportsThinking: entry.supports_reasoning,
    }));
  }
}

interface KimiChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
