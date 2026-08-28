# GLM Studio

Electron desktop app for Linux that talks to GLM (Zhipu / Z.ai), Anthropic Claude, and OpenAI, and
runs the Claude Code and Codex CLIs in an embedded terminal.

See [README.md](README.md) for user-facing setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design rationale.

## Commands

Run these directly — don't tell the user to run them.

```bash
npm run dev          # esbuild watch + auto-restarting Electron
npm test             # unit tests (node:test via scripts/test.mjs)
npm run typecheck    # tsc --noEmit
npm run check:wiring # every IPC channel, bridge method and event variant is connected
npm run build        # production bundles into dist/
npm run icons        # regenerate resources/icons
npm run dist         # AppImage / deb / tar.gz into release/ (rpm: npm run dist:rpm)
npm run install:desktop   # build + install the launcher entry
```

Always run `npm run typecheck && npm run check:wiring && npm test` before committing.

## Key files

| File | Purpose |
|---|---|
| `src/shared/types.ts` | Types shared by all three processes — start here |
| `src/shared/models.ts` | Endpoints, model catalog, provider constants |
| `src/shared/ipc.ts` | IPC channel names |
| `src/main/providers/registry.ts` | Adapter selection, abort handling, error mapping |
| `src/main/providers/cli.ts` | CLI transport — how subscription logins work |
| `src/main/providers/cli-stream.ts` | Parsers for all three CLIs' JSON-lines output |
| `src/main/auth/cli-session.ts` | Asks each CLI whether it is signed in |
| `src/main/agents/env.ts` | Environment handed to spawned CLIs |
| `src/main/agents/terminal.ts` | pty sessions, with pipe fallback |
| `src/main/store/secrets.ts` | Keyring-backed credential storage |
| `src/main/net/sse.ts` | SSE and JSON-lines parsers |
| `src/main/roundtable/engine.ts` | Round lifecycle, moderator brief and ruling |
| `src/main/roundtable/prompts.ts` | Every prompt the roundtable sends, plus its tolerant parsers |
| `src/main/telegram/bridge.ts` | Pairing, commands, and what gets mirrored |
| `src/shared/roundtable.ts` | Seats, roles, framing devices, room types |
| `src/preload/index.ts` | The entire renderer API surface |
| `src/renderer/main.ts` | App shell and view switching |
| `src/renderer/lib/markdown.ts` | Escape-then-transform Markdown renderer |
| `src/renderer/views/roundtable.ts` | The room: seat lanes, live research trails, seat editor |

## Conventions

- **No framework in the renderer.** Vanilla TS with the `h()` helper in `lib/dom.ts`.
- **Provider × transport.** Four providers (`glm`, `anthropic`, `openai`, `kimi`) × two transports
  (`api`, `cli`). Every combination goes through `ProviderAdapter`.
- **UI is data-driven from `PROVIDER_ORDER`.** Adding a provider to `shared/models.ts` makes it
  appear in the sidebar, login screen, and pickers automatically.
- **Comment the *why*.** The code says what it does; comments explain non-obvious decisions.

## Rules that must not be broken

- **Never read, copy, or forward subscription tokens** from `~/.claude/.credentials.json` or
  `~/.codex/auth.json`. Ask the CLI instead — `claude auth status --json`, `codex login status` —
  and read those files only as a fallback, only for whether a session exists and whose it is.
  Subscription requests go through the vendor CLI. This is the core design constraint — see
  `docs/LOGIN.md`.
- **Never widen the preload surface** into a generic `invoke(channel, …)`. Add an explicit typed
  method instead.
- **Never relax the renderer CSP**, especially `connect-src 'none'`. All network access belongs in
  the main process.
- **The Markdown renderer escapes first, then transforms.** Do not add a rule that emits a tag from
  unescaped input, and do not allow a URL scheme other than `http(s)` to reach an `href`.
- **Validate anything arriving from the renderer** in `ipc-handlers.ts` before it reaches a store —
  see `assertProvider` / `assertTransport`.
- **Never log credentials.** Use `redactHeaders` before logging any header map.
- **`ANTHROPIC_API_KEY` must stay deleted** from the GLM and Kimi child environments in
  `agents/env.ts`, or a stray value in the user's shell profile silently bills their Anthropic
  account — and every new provider that spawns a CLI must delete the other vendors' keys too.
- **Never seed a model id or context window you have not confirmed.** The picker's refresh control
  exists so an absent entry is recoverable; an invented one is quietly wrong forever.
- **A round must keep its lock until it returns, and must never save the room whole.** Releasing on
  abort let a second round start on a stale copy and destroy a transcript; saving whole erased a
  `closed` status and any seat edit made while the round ran — see `roundtable/round-plan.ts`.
- **An unparseable moderator ruling must never mean "conclude".** `parseVerdict` defaults to
  continuing; reading noise as agreement ends a discussion nobody finished.
- **The Telegram bridge answers only paired chats.** Never add a path that acts on a message from a
  chat outside `telegram.allowedChatIds`.
- **The reasoning switch is per model family, on two providers now.** Kimi K2.x takes
  `thinking: {type}`; K3 always thinks and takes a top-level `reasoning_effort` — `usesReasoningEffort()`
  picks. K3 also needs its `reasoning_content` echoed back or multi-turn degrades.
- **Never send `budget_tokens` or `temperature` to a modern Anthropic model** — both are rejected
  with a 400 on Opus 4.6+, Sonnet 4.6+ and Fable. `usesAdaptiveThinking()` picks the shape.
- **Never probe a CLI flag without checking `probeCapabilities` first.** An unrecognised flag makes
  the CLI exit non-zero and loses the turn.
- **Chat and roundtable turns must not run the CLIs as coding agents.** Replace the system prompt
  (`--system-prompt`, never append) and restrict the toolset with `--restricted --tools` — see
  `providers/cli-args.ts`. **`--allowedTools` is not a restriction**: it auto-approves what it names
  and leaves all 42 built-in tools available, Bash and Write among them.
- **A CLI stream parser must handle both the deltas and the finished message**, and emit the reply
  exactly once. Dropping the whole-message path makes older builds return nothing while exiting
  zero; dropping the delta bookkeeping prints every reply twice — see `providers/cli-stream.ts`.
- **Light and dark are both first-class.** Every colour is a token; check contrast before changing
  the palette — the light theme's text and semantic colours are chosen to pass WCAG AA.

## Testing

`npm test` bundles every `src/**/*.test.ts` with esbuild and runs it under `node:test`. Tests cover
the pure logic — SSE framing, Markdown escaping, the Zhipu JWT, HTTP error mapping. Modules that
import Electron are verified by running the app, not by mocking.

To verify UI changes headlessly:

```bash
xvfb-run -a npx electron . --no-sandbox
```
