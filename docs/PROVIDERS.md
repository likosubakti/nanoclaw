# Providers

Endpoint, authentication, and request-shape details for each backend, plus how to add another.

---

## GLM (Zhipu / Z.ai)

### Endpoints

| Preset | Chat base URL | Anthropic-compatible base URL |
|---|---|---|
| Z.ai — International | `https://api.z.ai/api/paas/v4` | `https://api.z.ai/api/anthropic` |
| Z.ai — Coding Plan | `https://api.z.ai/api/coding/paas/v4` | `https://api.z.ai/api/anthropic` |
| Bigmodel — Mainland China | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/anthropic` |

The international (`z.ai`) and mainland (`open.bigmodel.cn`) platforms are separate products with
separate accounts. A key from one returns `401` on the other — the single most common setup
mistake, and what the endpoint selector exists to prevent.

### Authentication

`Authorization: Bearer <token>`, where the token depends on the key format:

- **z.ai keys** are passed through unchanged.
- **Bigmodel keys** arrive as `{id}.{secret}` and must be exchanged for a short-lived HS256 JWT with
  `{"alg":"HS256","sign_type":"SIGN"}` in the header and `{api_key, exp, timestamp}` in the payload.
  `auth/zhipu-jwt.ts` does this automatically — the format is detected, and tokens are cached for an
  hour so a burst of requests does not re-sign every time.

A three-segment string is treated as an already-signed JWT, not a composite key.

### Request shape

OpenAI-compatible `POST /chat/completions`, with two GLM-specific details:

- `thinking: { type: "enabled" }` switches on hybrid reasoning for GLM-4.5 and newer. It is only
  sent when the user asks for it, since older models reject the field.
- Reasoning arrives on `choices[0].delta.reasoning_content`, separate from `.content`.

### Models

`glm-4.6` (flagship, 200K context), `glm-4.5`, `glm-4.5-air`, `glm-4.5-flash` (free tier),
`glm-4v` (vision). The refresh button beside the model picker on the Login screen replaces
this list with whatever the provider currently returns from `/models`.

---

## Anthropic (Claude)

### Endpoint

`https://api.anthropic.com/v1/messages`

### Authentication

`x-api-key: <key>` plus `anthropic-version: 2023-06-01`.

**A Claude Pro/Max subscription is not usable here.** Those credentials belong to the Claude Code
CLI and are not valid for the public API. Switch the provider to the *Claude Code* transport
instead — see [LOGIN.md](LOGIN.md).

### Request shape

- The system prompt is a top-level `system` field, not a message.
- Extended thinking sets `thinking: { type: "enabled", budget_tokens }`. The budget comes out of
  `max_tokens`, so the app raises `max_tokens` to `budget + 1024` and drops `temperature` — the API
  rejects a temperature override while thinking is on.
- Deltas arrive as named SSE events: `content_block_delta` carries `text_delta` or `thinking_delta`;
  usage arrives in `message_start` and `message_delta`.

---

## OpenAI

### Endpoint

`https://api.openai.com/v1/chat/completions`

Chat Completions rather than the Responses API on purpose: it is the endpoint every OpenAI-compatible
gateway implements, so overriding the base URL to point at Azure, a local llama.cpp server, or Z.ai's
OpenAI-compatible surface keeps working.

### Authentication

`Authorization: Bearer <key>`.

**A ChatGPT Plus/Pro subscription is not usable here** — use the *Codex CLI* transport.

### Request shape

Reasoning models (`o*`, `gpt-5*`) are detected by id and treated differently:

| | Standard models | Reasoning models |
|---|---|---|
| Token cap | `max_tokens` | `max_completion_tokens` |
| `temperature` | sent | omitted (rejected by the API) |
| Thinking | — | `reasoning_effort: "high"` |

`stream_options: { include_usage: true }` requests usage in the final chunk; gateways that do not
support it ignore the field.

---

## The CLI transport

Both agent CLIs are driven headlessly, with the prompt on stdin so it never appears in the process
table.

### Claude Code

```
claude --print --output-format stream-json --verbose --include-partial-messages \
       [--model M] [--resume SESSION] [--append-system-prompt P]
```

Emitted JSON lines:

| Line | Meaning |
|---|---|
| `{type:"system", subtype:"init", session_id}` | Session id, stored so the next turn can `--resume` |
| `{type:"stream_event", event:{type:"content_block_delta", …}}` | Token deltas (`text_delta`, `thinking_delta`) |
| `{type:"assistant", message:{content:[…]}}` | Whole turn — the fallback when partial streaming is unavailable |
| `{type:"result", usage, session_id}` | Token counts and the final session id |

`--include-partial-messages` is only supported by newer releases; older ones ignore the flag, which
is why whole `assistant` messages are handled too.

### Codex

```
codex exec --json --skip-git-repo-check [--model M] -
```

Codex has changed its JSON envelope across releases, so the parser accepts every shape it has used:
`msg.type` deltas (`agent_message_delta`, `agent_reasoning_delta`, `exec_command_begin`,
`token_count`) and newer `item.completed` items. Unrecognised lines are skipped rather than
treated as an error.

### GLM through Claude Code

Z.ai exposes an Anthropic-compatible surface, so Claude Code drives GLM unchanged once the
environment points at it. `agents/env.ts` sets, for that child process only:

```
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=<your Z.ai key>
ANTHROPIC_MODEL=glm-4.6
ANTHROPIC_SMALL_FAST_MODEL=glm-4.5-air
API_TIMEOUT_MS=600000
```

`ANTHROPIC_API_KEY` is explicitly **deleted** from the child environment. If it survived, a stray
value in the user's shell profile would take precedence over `ANTHROPIC_AUTH_TOKEN` and silently
bill their Anthropic account instead of using GLM.

---

## Adding a provider

1. Add the id to `ProviderId` in `src/shared/types.ts`.
2. Add labels, default base URL, model entries, key-portal URL, and env-var names in
   `src/shared/models.ts`.
3. Implement `ProviderAdapter` in `src/main/providers/`. If the API is OpenAI-shaped, `glm.ts` is
   the shortest thing to copy — it already exports the shared `buildMessages` and `failure` helpers.
4. Register it in `src/main/providers/registry.ts`.
5. If it has a CLI, add it to `PROVIDER_CLI` and give it a case in `agents/env.ts`.

The UI is data-driven from `PROVIDER_ORDER`, so the sidebar chips, login cards, model pickers, and
settings sections all appear on their own.
