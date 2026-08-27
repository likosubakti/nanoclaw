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
  preload/           the contextBridge surface
  renderer/
    main.ts          app shell, view switching
    state.ts         tiny observable store
    lib/             dom helpers, markdown renderer
    views/           chat, agent, login, settings
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
