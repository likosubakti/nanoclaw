import type { ChatRequest } from '@shared/types';

/**
 * Request-shape decisions for the Kimi API.
 *
 * Kept apart from `kimi.ts`, which reaches Electron through the secret and
 * settings stores: these are pure and therefore testable, and they are exactly
 * where being wrong is expensive — the wrong reasoning shape is a 400, and a
 * dropped `reasoning_content` silently degrades every K3 turn after the first.
 */

/**
 * Which reasoning shape a model takes.
 *
 * The K2 family switches thinking on with `thinking: {type: "enabled"}`. K3
 * always thinks, cannot be switched off, and is tuned with a top-level
 * `reasoning_effort` of "low" | "high" | "max" — there is no "medium". Sending
 * one family's shape to the other is the same class of mistake as sending
 * `budget_tokens` to a modern Anthropic model.
 */
export function usesReasoningEffort(model: string): boolean {
  return /^kimi-k([3-9]|\d{2})/i.test(model.trim());
}

/**
 * Kimi's message history, which is not GLM's.
 *
 * K3 requires the assistant message to be echoed back complete — including
 * `reasoning_content` — or multi-turn and tool use degrade. An empty string
 * means "reasoned, but produced nothing" and must round-trip as an empty
 * string rather than being dropped, so the field is emitted whenever it was
 * captured at all, not merely when it is non-empty.
 */
export function buildKimiMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: req.systemPrompt.trim() });
  }
  for (const message of req.messages) {
    const isAssistant = message.role === 'assistant';
    if (!isAssistant && !message.content.trim()) continue;
    messages.push({
      role: message.role,
      content: message.content,
      ...(isAssistant && message.reasoning !== undefined
        ? { reasoning_content: message.reasoning }
        : {}),
    });
  }
  return messages;
}

