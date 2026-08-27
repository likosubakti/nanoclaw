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
npm run build        # production bundles into dist/
npm run icons        # regenerate resources/icons
npm run dist         # AppImage / deb / tar.gz into release/ (rpm: npm run dist:rpm)
npm run install:desktop   # build + install the launcher entry
```

Always run `npm run typecheck && npm test` before committing.

## Key files

| File | Purpose |
|---|---|
| `src/shared/types.ts` | Types shared by all three processes — start here |
| `src/shared/models.ts` | Endpoints, model catalog, provider constants |
| `src/shared/ipc.ts` | IPC channel names |
| `src/main/providers/registry.ts` | Adapter selection, abort handling, error mapping |
| `src/main/providers/cli.ts` | CLI transport — how subscription logins work |
| `src/main/agents/env.ts` | Environment handed to spawned CLIs |
| `src/main/agents/terminal.ts` | pty sessions, with pipe fallback |
| `src/main/store/secrets.ts` | Keyring-backed credential storage |
| `src/main/net/sse.ts` | SSE and JSON-lines parsers |
| `src/preload/index.ts` | The entire renderer API surface |
| `src/renderer/main.ts` | App shell and view switching |
| `src/renderer/lib/markdown.ts` | Escape-then-transform Markdown renderer |

## Conventions

- **No framework in the renderer.** Vanilla TS with the `h()` helper in `lib/dom.ts`.
- **Provider × transport.** Three providers (`glm`, `anthropic`, `openai`) × two transports
  (`api`, `cli`). Every combination goes through `ProviderAdapter`.
- **UI is data-driven from `PROVIDER_ORDER`.** Adding a provider to `shared/models.ts` makes it
  appear in the sidebar, login screen, and pickers automatically.
- **Comment the *why*.** The code says what it does; comments explain non-obvious decisions.

## Rules that must not be broken

- **Never read, copy, or forward subscription tokens** from `~/.claude/.credentials.json` or
  `~/.codex/auth.json`. Read only whether a session exists and whose it is. Subscription requests go
  through the vendor CLI. This is the core design constraint — see `docs/LOGIN.md`.
- **Never widen the preload surface** into a generic `invoke(channel, …)`. Add an explicit typed
  method instead.
- **Never relax the renderer CSP**, especially `connect-src 'none'`. All network access belongs in
  the main process.
- **The Markdown renderer escapes first, then transforms.** Do not add a rule that emits a tag from
  unescaped input, and do not allow a URL scheme other than `http(s)` to reach an `href`.
- **Validate anything arriving from the renderer** in `ipc-handlers.ts` before it reaches a store —
  see `assertProvider` / `assertTransport`.
- **Never log credentials.** Use `redactHeaders` before logging any header map.
- **`ANTHROPIC_API_KEY` must stay deleted** from the GLM child environment in `agents/env.ts`, or a
  stray value in the user's shell profile silently bills their Anthropic account.

## Testing

`npm test` bundles every `src/**/*.test.ts` with esbuild and runs it under `node:test`. Tests cover
the pure logic — SSE framing, Markdown escaping, the Zhipu JWT, HTTP error mapping. Modules that
import Electron are verified by running the app, not by mocking.

To verify UI changes headlessly:

```bash
xvfb-run -a npx electron . --no-sandbox
```
