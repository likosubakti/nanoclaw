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
- **The request shape changed with the 4.6 generation, and the old one is a hard error.** On Opus
  4.6+, Sonnet 4.6+ and Fable, `thinking: { type: "enabled", budget_tokens }` and `temperature`
  are both rejected with a `400`. Those models take `thinking: { type: "adaptive" }` and no
  sampling parameters at all. Older models still require `budget_tokens` for thinking, and still
  accept `temperature`.
- `usesAdaptiveThinking()` in `providers/anthropic.ts` decides which shape to send. It defaults to
  the modern shape for anything unrecognised: new releases follow the current shape, and sending
  the legacy shape to a modern model is a hard failure while the reverse merely loses thinking.
- Deltas arrive as named SSE events: `content_block_delta` carries `text_delta` or `thinking_delta`;
  usage arrives in `message_start` and `message_delta`.

### Models

Model ids are complete as written — never append a date suffix. The catalog is grouped by tier
(flagship / balanced / fast), which is what makes per-seat model choice in the Roundtable a
one-glance decision: `claude-opus-5` and `claude-fable-5` in the chair that decides,
`claude-haiku-4-5` in a seat that only needs an opinion.

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

## Kimi (Moonshot AI)

### Endpoints

| Preset | Chat base URL | Reachable from |
|---|---|---|
| Moonshot — International | `https://api.moonshot.ai/v1` | both transports |
| Moonshot — Mainland China | `https://api.moonshot.cn/v1` | both transports |
| Kimi Code — Subscription | `https://api.kimi.com/coding/v1` | **the CLI only** |

The subscription surface is deliberately absent from the endpoint picker.
Moonshot restricts a Kimi Code key to their own CLI, Claude Code and Roo Code, and says other use
"may be considered misuse and could result in restricted access" — so this app reaches it only by
driving `kimi`, never over its own HTTP client. Keys are created at
`platform.kimi.ai` (international) or `platform.kimi.com` (mainland).

The same three-surface split as GLM, for the same reason: `.ai` and `.cn` are separate platforms
with separate accounts, and a key from one returns `401` on the other. These URLs are not guesses —
they are the platform table inside Moonshot's own CLI (`kimi_cli/auth/platforms.py`), which is the
authority on where its client points.

### Authentication

`Authorization: Bearer <key>`. Unlike Bigmodel's, Kimi keys are used as issued — no JWT signing.

### Request shape

OpenAI-compatible `POST /chat/completions`. Reasoning arrives on
`choices[0].delta.reasoning_content` — the same field name GLM uses.

**The reasoning switch differs by model family, and sending the wrong one is a hard error.** K2.x
takes `thinking: { type: "enabled" }`. K3 always thinks — there is no way to switch it off — and is
tuned with a top-level `reasoning_effort` of `"low" | "high" | "max"` (default `max`; there is no
`"medium"`). `usesReasoningEffort()` picks the shape, and defaults to the newer one for anything
unrecognised, for the same reason `usesAdaptiveThinking()` does on the Anthropic side.

**K3 needs its reasoning echoed back.** The complete assistant message must return to `messages`
with `reasoning_content` intact, or multi-turn and tool use degrade — and an empty string means
"reasoned but produced nothing", so it has to round-trip as an empty string rather than be dropped.
That is why Kimi builds its own message array instead of reusing GLM's.

`max_completion_tokens` rather than `max_tokens`, which Moonshot deprecated.

### Models

`kimi-k3` is the flagship: 1,048,576-token context, natively multimodal, always thinking. It needs a
paid top-up to unlock, which is why the **default** stays `kimi-k2.6` — 256K context, switchable
thinking, and the cheaper choice. Also seeded: `kimi-k2-thinking`, `kimi-k2.5`,
`kimi-k2-turbo-preview`, all 256K.

`/models` returns `context_length` and `supports_reasoning` per model, so the refresh control beside
the picker replaces this list with what the account can actually see — which matters here, since a
key without the top-up may not list K3 at all.

The Kimi Code plan exposes `kimi-for-coding` and `kimi-for-coding-highspeed` instead. Those are
stable pointers whose backing model changes server-side, so nothing may pin a context window to
them.

### Kimi Code CLI

Kimi is the one non-Anthropic provider that does **not** borrow Claude Code: it ships its own agent
CLI with its own device-code OAuth sign-in, so the CLI transport drives that instead.

Install `@moonshot-ai/kimi-code` from npm; the binary is `kimi`. Three near-miss packages exist and
none is the right one — see [LOGIN.md](LOGIN.md#subscription-sign-in).

```
kimi --output-format stream-json [--agent-file FILE] --prompt "…"
```

Three things differ from the other CLIs, and each changes what the app can promise:

**The prompt is an argv value, not stdin.** Kimi's prompt mode takes no piped input, so unlike
`claude` and `codex` the text is visible in the process table for the length of the turn. That is a
real difference in kind and is called out rather than left to be discovered.

**`--model` names a config alias, not an API model id.** Passing a catalog id fails the turn
outright — `Model "kimi-k2.6" is not configured in config.toml.` — so the seat's model is
deliberately **not** sent and the CLI's own configured default decides. Per-seat model choice
applies to the `api` transport, where ids are real.

**The toolset is cut by an agent profile, not a flag.** `--agent-file` takes Markdown with YAML
frontmatter; the frontmatter's `tools:` is an allowlist, so `tools: []` really is no tools, and
`subagents: []` matters as much — an inherited subagent would run unrestricted. A discussion turn
writes a throwaway profile to a temp directory and removes it in a `finally`.

Wire format — role-tagged and OpenAI-message-shaped, not the internal event bus that `kimi acp`
speaks:

```json
{"role":"meta","type":"system.version","version":"0.39.0"}
{"role":"assistant","content":"…","tool_calls":[{"type":"function","id":"…",
                                  "function":{"name":"…","arguments":"{…}"}}]}
{"role":"tool","tool_call_id":"…","content":"…"}
```

`content` is a plain string, and the writer flushes one line per assistant message, so each line is
new content and the parser appends. **Thinking deltas are discarded by that writer**, so a Kimi CLI
seat has no reasoning trail — the API transport does. The legacy Python CLI wrote `content` as an
array of typed parts instead; both shapes are accepted, so a user who still has the old binary on
`PATH` gets a working seat rather than a silently empty one.

Environment handed to the child: `KIMI_API_KEY` and `KIMI_BASE_URL` (names the CLI reads) when an
API key is configured, and `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`
explicitly deleted — Kimi Code loads plugins and MCP servers of the user's choosing, and a stray
key is exactly what one would reach for.

Auth hosts are region-split like the API: `auth.kimi.com` (mainland) and `auth.kimi.ai` (global),
selected by `kimi login --region mainland-cn|global`.


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

`--include-partial-messages` is only supported by newer releases; older ones ignore the flag and
send only whole `assistant` messages, so those carry the reply on those builds. The parser is
created per stream and remembers whether deltas arrived: without that memory a stream either prints
every reply twice or — on a build with no deltas — prints nothing at all while exiting zero. The
`result` line's own text is held back as a last resort for the same reason. Codex is parsed the same
way, because some of its releases emit both a delta stream and the finished message.

### Codex

```
codex exec --json --skip-git-repo-check [--model M] -
```

Codex has changed its JSON envelope across releases, so the parser accepts every shape it has used:
`msg.type` deltas (`agent_message_delta`, `agent_reasoning_delta`, `exec_command_begin`,
`token_count`), newer `item.completed` items, and `turn.completed` for usage. Unrecognised lines are
skipped rather than treated as an error.

Three things about Codex that are not obvious and each cost a turn if missed:

- **`error` is not always fatal.** Retry chatter arrives as `error` — "Reconnecting... 2/5 (stream
  disconnected)" four times during a turn that goes on to succeed. Only terminal errors are
  surfaced, or a network blip paints the room red mid-turn.
- **A wedged Codex never exits.** With no credentials it retries to 5/5 and then waits, forever, so
  the CLI transport carries a stall guard: five minutes with no output at all and the child is
  stopped with a message naming the likely cause. Every line resets it, so a long working turn is
  never cut off.
- **`AGENTS.md` is injected silently.** A turn runs in the user's workspace and Codex prepends any
  `AGENTS.md` it finds there — coding instructions written for a repository, pushed into a
  discussion about something else. `--ignore-user-config` does not cover it (project docs are not
  user config); `-c project_doc_max_bytes=0` does, and discussion turns set it.

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
