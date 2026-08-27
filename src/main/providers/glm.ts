import type { ChatRequest, ConnectionTestResult, ModelInfo } from '@shared/types';
import { HttpError, hostOf, request } from '../net/http';
import { readSse } from '../net/sse';
import { resolveApiKey } from '../store/secrets';
import { loadSettings, resolveBaseUrl } from '../store/settings';
import { bearerForZhipu } from '../auth/zhipu-jwt';
import { createLogger } from '../util/logger';
import { MissingCredentialsError, type ProviderAdapter, type ProviderContext } from './types';

const log = createLogger('provider:glm');

/**
 * GLM speaks an OpenAI-shaped chat completions API with two additions worth
 * handling: a `thinking` switch on the 4.5/4.6 family, and `reasoning_content`
 * deltas that carry the chain of thought separately from the answer.
 */
export class GlmProvider implements ProviderAdapter {
  private auth(): { headers: Record<string, string>; baseUrl: string } {
    const resolved = resolveApiKey('glm');
    if (!resolved) {
      throw new MissingCredentialsError(
        'Add a Z.ai API key in Settings → Providers → GLM, or sign in through the Login screen.',
      );
    }
    const settings = loadSettings();
    return {
      baseUrl: resolveBaseUrl('glm', settings),
      headers: {
        // bigmodel.cn keys are `id.secret` and need a signed JWT; z.ai keys pass through.
        authorization: `Bearer ${bearerForZhipu(resolved.key)}`,
        ...(settings.providers.glm.headers ?? {}),
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
    // GLM-4.5 and newer take an explicit hybrid-reasoning switch. Sending it to
    // an older model is rejected, so only include it when asked for.
    if (req.thinking) body.thinking = { type: 'enabled' };

    log.debug(`streaming ${model} from ${hostOf(baseUrl)}`);

    const response = await request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: ctx.signal,
    });

    if (!response.body) throw new Error('GLM returned an empty response body.');

    for await (const message of readSse(response.body, ctx.signal)) {
      if (message.data === '[DONE]') break;

      let chunk: GlmChunk;
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
      const model = loadSettings().providers.glm.defaultModel || 'glm-4.5-flash';
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

  async listModels(): Promise<ModelInfo[]> {
    const { baseUrl, headers } = this.auth();
    const response = await request(`${baseUrl}/models`, { headers, timeoutMs: 20_000 });
    const payload = (await response.json()) as { data?: Array<{ id: string }> };
    return (payload.data ?? []).map((entry) => ({
      id: entry.id,
      provider: 'glm' as const,
      label: entry.id,
    }));
  }
}

interface GlmChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Shared by GLM and OpenAI: both take the same message array shape. */
export function buildMessages(req: ChatRequest): Array<{ role: string; content: string }> {
  const messages = req.messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  if (req.systemPrompt?.trim()) {
    return [{ role: 'system', content: req.systemPrompt.trim() }, ...messages];
  }
  return messages;
}

export function failure(err: unknown): ConnectionTestResult {
  if (err instanceof MissingCredentialsError) {
    return { ok: false, message: 'No credentials configured.', hint: err.hint };
  }
  if (err instanceof HttpError) {
    const { message, hint } = err.friendly;
    return { ok: false, message, hint };
  }
  return { ok: false, message: (err as Error).message || 'Unknown error.' };
}
