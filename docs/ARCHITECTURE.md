# Architecture

## Process model

Standard Electron three-process split, with a hard rule: **the renderer never touches the network
or the filesystem.** Its CSP sets `connect-src 'none'`, so a bug in Markdown rendering cannot turn
into data exfiltration.

```
┌─ main process ──────────────────────────────────────────┐
│  window · menu · IPC handlers                           │
│  providers/  → HTTPS to Z.ai / Anthropic / OpenAI       │
│  agents/     → spawns claude, codex (node-pty)          │
│  store/      → settings, secrets (safeStorage), history │
└───────────────────────┬─────────────────────────────────┘
                        │ contextBridge, typed methods only
┌───────────────────────┴─────────────────────────────────┐
│  preload (contextIsolation on, no generic invoke)       │
└───────────────────────┬─────────────────────────────────┘
                        │ window.glm.*
┌───────────────────────┴─────────────────────────────────┐
│  renderer — vanilla TS, no framework                    │
│  views/chat · views/agent · views/login · views/settings│
└─────────────────────────────────────────────────────────┘
```

The preload exposes an explicit, typed method per operation rather than a generic
`invoke(channel, …)`. There is no way for renderer code to reach an IPC handler that was not
deliberately surfaced.

## Layout

```
src/
  shared/            types, IPC channel names, model catalog  (imported by all three processes)
  main/
    index.ts         lifecycle, single-instance lock, argv routing
    window.ts        window creation, bounds persistence, navigation guards
    menu.ts          menu bar
    ipc-handlers.ts  every ipcMain.handle, with input validation
    store/           paths (XDG), settings, secrets, conversations
    net/             http (structured errors), sse (SSE + JSON-lines parsers)
    providers/       glm, anthropic, openai, cli, registry
    agents/          cli-detect, env, terminal
    auth/            zhipu-jwt, cli-credentials, login-flows
    roundtable/      engine (rounds, moderator), prompts, store
    telegram/        bot API client, bridge (pairing, commands, broadcast)
  preload/           the contextBridge surface
  renderer/
    main.ts          app shell, view switching
    state.ts         tiny observable store
    lib/             dom helpers, markdown renderer
    views/           chat, roundtable, agent, login, settings
```

## The provider abstraction

Two orthogonal axes: **provider** (`glm` / `anthropic` / `openai`) and **transport**
(`api` / `cli`). Six combinations, one interface:

```ts
interface ProviderAdapter {
  stream(request: ChatRequest, ctx: ProviderContext): Promise<void>;
  test(): Promise<ConnectionTestResult>;
  listModels?(): Promise<ModelInfo[]>;
}
```

`registry.ts` picks the adapter, owns the `AbortController`, and turns any thrown error into an
`error` event — so the renderer's event stream is the single source of truth for how a turn ended.

### Why the CLI transport exists

A Claude Pro/Max or ChatGPT Plus/Pro login is not a valid bearer token for the public API. Reusing
those tokens would mean impersonating the vendor's own client. Instead, `CliProvider` hands the
prompt to `claude` or `codex` over stdin and parses their JSON output. The subscription session
stays inside the tool that owns it, and the agent's tools come along for free.

## Streaming

One event type flows from the adapters to the UI:

```ts
type StreamEvent =
  | { type: 'start';     streamId }
  | { type: 'reasoning'; streamId; text }
  | { type: 'text';      streamId; text }
  | { type: 'tool';      streamId; name; detail? }
  | { type: 'session';   streamId; sessionId }   // CLI transports
  | { type: 'usage';     streamId; inputTokens?; outputTokens? }
  | { type: 'done';      streamId; finishReason?; durationMs }
  | { type: 'error';     streamId; message; hint? }
```

`chat:send` returns immediately; events arrive on `chat:event`. Awaiting the completion inside the
IPC reply would block the channel for the whole turn.

The chat view re-renders the live message from its accumulated text on every delta rather than
appending nodes. That costs a little CPU but means partial Markdown — an open code fence, a
half-written table — renders correctly as it streams.

### Wire formats

`net/sse.ts` handles all three vendors' SSE dialects, which differ in ways that matter:

- OpenAI and GLM send bare `data:` lines terminated by `[DONE]`.
- Anthropic uses named `event:` types (`content_block_delta`, `message_delta`, …).
- Event boundaries land anywhere in a chunk, including inside a multi-byte UTF-8 sequence — the
  decoder runs with `{ stream: true }` so a split codepoint is buffered, not replaced with U+FFFD.

`readJsonLines` handles the CLI transports, skipping non-JSON chatter that the tools interleave
with their output.

## Terminals

`agents/terminal.ts` owns the pty sessions; the renderer owns the xterm instances; both are keyed
by the same id. Output is forwarded straight from the pty to the renderer without buffering in the
main process.

`node-pty` is loaded with `require` inside a `try`. It is an N-API module, so the binary built at
`npm install` time loads under Electron unchanged — no Electron-specific rebuild is needed, and
`electron-builder`'s `npmRebuild` is disabled precisely because that rebuild deletes the working
binary before trying (and possibly failing) to replace it. When the binary is missing anyway,
terminals fall back to `child_process` pipes and `TerminalInfo.pty` tells the UI to show a banner
rather than pretending everything is fine.

## The Roundtable

`roundtable/engine.ts` runs rounds; the seats themselves are ordinary `ProviderAdapter` calls, so
the discussion inherits every backend and transport for free. Three decisions shape it:

- **A seat is a configuration, not a backend.** Several seats may share one provider, transport and
  account, differing only in role. That is what makes "three Claudes as cryptographer, SRE and CTO"
  a real thing rather than a relabelling.
- **The moderator is scaffolding, and scaffolding must fail soft.** It writes the brief, tailors it
  per role, and rules on each round — but a moderator that errors degrades to un-tailored
  instructions, and its free-text output is read by tolerant parsers where an unparseable ruling
  means *continue*, never *conclude*. Declaring a consensus nobody reached is the one unacceptable
  failure.
- **Variation is engineered, not hoped for.** Identical seats and topic converge on identical
  framing, so the moderator samples a framing device per round from a fixed set, is shown the ones
  already used, and briefs at a temperature set by a per-room dial. Rulings run cooler than briefs.

Only `parallel` mode runs seats concurrently; every other mode is a conversation and has to be
ordered. There is no round cap by design, so the engine reports running token totals after each
round rather than enforcing a budget.

## The Telegram bridge

`telegram/bridge.ts` long-polls `getUpdates`, because a desktop app has no public URL and asking a
user to expose one would be absurd.

The security model is the interesting part. A bot token is not a secret from anyone who can find the
bot, so the bridge answers **nobody** by default: a chat must send a live pairing code, shown in the
app, before it can drive anything. Six digits is only 900,000 possibilities and the bot answers
every guess, so the code is its own oracle — which is safe only because it is consumed on first use,
expires after ten minutes, and is burned after five wrong guesses. Unpaired chats get a single
refusal and are otherwise ignored, which is both good manners and a rate limit: the poll loop
handles updates serially, so a reply to a stranger delays the owner's own commands.

Turn text is posted as each turn completes rather than streamed. Telegram throttles chatty bots, and
a token-by-token mirror would be rate-limited into uselessness; short status lines carry progress
instead. Rounds started in the app are mirrored too, so the phone is a window on the room rather
than a second channel.

## Storage

- **Settings** — one JSON file, deep-merged over defaults on read, so a new key appears after an
  upgrade instead of failing.
- **Secrets** — `safeStorage.encryptString` when a keyring is available; base64 in a `0600` file
  otherwise, with the backend recorded in the file and surfaced in Diagnostics.
- **Conversations** — one JSON file each. Small, greppable, backup-friendly, and a corrupt file
  loses one conversation rather than the database.

## Security decisions

| Decision | Reason |
|---|---|
| `contextIsolation: true`, `nodeIntegration: false` | Standard hardening |
| `connect-src 'none'` in the renderer CSP | The renderer has no legitimate reason to make requests |
| Escape-then-transform Markdown renderer | Model output cannot produce an element the renderer did not construct; no sanitiser to get wrong |
| Only `http(s)` URLs become anchors | `javascript:` and `data:` links can never reach an `href` |
| `will-navigate` and `setWindowOpenHandler` guards | A compromised renderer cannot navigate itself elsewhere |
| `openExternal` restricted to `https?:` and `mailto:` | `file://` and custom schemes are an execution vector |
| Conversation ids sanitised before path joining | No directory traversal from a crafted id |
| Prompts passed to CLIs over stdin | Keeps them out of the process table |
| Header redaction in the logger | Keys never reach the log file |

## Build

`scripts/build.mjs` runs esbuild three times: main (ESM, node, `electron`/`node-pty` external),
preload (CJS — sandboxed preloads cannot use ESM), and renderer (browser, everything bundled
including xterm).

No framework and no bundler config format to track. The renderer bundle is ~330 KB, most of which
is xterm.

`scripts/gen-icons.mjs` rasterises the app icon to PNG with a dependency-free encoder — build
machines rarely have ImageMagick or librsvg, and controlling the rasteriser means `npm run icons`
produces identical bytes everywhere.

## Testing

`npm test` bundles every `*.test.ts` with esbuild (resolving the `@shared/*` alias) and runs them
under `node:test`. Coverage is on the pure logic where bugs are silent and costly: SSE framing,
Markdown escaping, the Zhipu JWT, and HTTP error mapping. Modules that need Electron are exercised
by running the app rather than by mocking it.
