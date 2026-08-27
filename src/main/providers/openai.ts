import type { ChatRequest, ConnectionTestResult, ModelInfo } from '@shared/types';
import { hostOf, request } from '../net/http';
import { readSse } from '../net/sse';
import { resolveApiKey } from '../store/secrets';
import { loadSettings, resolveBaseUrl } from '../store/settings';
import { createLogger } from '../util/logger';
import { MissingCredentialsError, type ProviderAdapter, type ProviderContext } from './types';
import { buildMessages, failure } from './glm';

const log = createLogger('provider:openai');

/**
 * OpenAI Chat Completions over SSE.
 *
 * Chat Completions rather than Responses on purpose: it is the endpoint every
 * OpenAI-compatible gateway implements, so pointing the base URL at a local
 * llama.cpp server, an Azure deployment, or Z.ai's OpenAI-compatible surface
 * keeps working. A ChatGPT subscription is not usable here — use the `cli`
 * transport and let Codex handle that login.
 */
export class OpenAiProvider implements ProviderAdapter {
  private auth(): { headers: Record<string, string>; baseUrl: string } {
    const resolved = resolveApiKey('openai');
    if (!resolved) {
      throw new MissingCredentialsError(
        'Add an OpenAI API key in Settings → Providers → OpenAI, or switch that provider to the "Codex CLI" transport to use a ChatGPT subscription.',
      );
    }
    const settings = loadSettings();
    return {
      baseUrl: resolveBaseUrl('openai', settings),
      headers: {
        authorization: `Bearer ${resolved.key}`,
        ...(settings.providers.openai.headers ?? {}),
      },
    };
  }

  async stream(req: ChatRequest, ctx: ProviderContext): Promise<void> {
    const { baseUrl, headers } = this.auth();
    const reasoningModel = isReasoningModel(req.model);

    const body: Record<string, unknown> = {
      model: req.model,
      messages: buildMessages(req),
      stream: true,
      // Ask for usage in the final chunk; older gateways ignore the field.
      stream_options: { include_usage: true },
    };

    // Reasoning models reject `temperature` and rename the token cap.
    if (reasoningModel) {
      body.max_completion_tokens = req.maxTokens;
      if (req.thinking) body.reasoning_effort = 'high';
    } else {
      body.max_tokens = req.maxTokens;
      body.temperature = req.temperature;
    }

    log.debug(`streaming ${req.model} from ${hostOf(baseUrl)}`);

    const response = await request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: ctx.signal,
    });
    if (!response.body) throw new Error('OpenAI returned an empty response body.');

    for await (const message of readSse(response.body, ctx.signal)) {
      if (message.data === '[DONE]') break;

      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(message.data);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      // Some gateways mirror GLM and expose reasoning on the delta.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        ctx.emit({ type: 'reasoning', streamId: ctx.streamId, text: reasoning });
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
      const model = loadSettings().providers.openai.defaultModel;
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
      };
      if (isReasoningModel(model)) body.max_completion_tokens = 16;
      else body.max_tokens = 1;

      await request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
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
    const response = await request(`${baseUrl}/models`, { headers, timeoutMs: 20_000 });
    const payload = (await response.json()) as { data?: Array<{ id: string }> };
    return (payload.data ?? [])
      .map((entry) => ({ id: entry.id, provider: 'openai' as const, label: entry.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** o-series and GPT-5 use `max_completion_tokens` and forbid `temperature`. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
