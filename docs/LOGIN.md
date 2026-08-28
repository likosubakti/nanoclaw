# Logging in

Every backend can be reached two ways. Pick per provider on the **Login & Providers** screen.

| | API key | Subscription |
|---|---|---|
| GLM (Z.ai) | ✅ the only option | — |
| Claude | ✅ Anthropic Console | ✅ Claude Pro / Max, via `claude` |
| OpenAI | ✅ OpenAI Platform | ✅ ChatGPT Plus / Pro, via `codex` |
| Kimi (Moonshot) | ✅ Moonshot Platform | ✅ Kimi, via `kimi` |

GLM is the only one with no subscription sign-in of its own: its CLI is Claude Code borrowed and
pointed at Z.ai, so there is no GLM account to log in to. Kimi ships its own agent CLI with its own
OAuth flow, so it works like Claude and OpenAI do.

---

## API keys

1. Open **Login & Providers**.
2. Click **Get a key** on the provider's card. A window opens on that vendor's key page — sign in
   there and create a key.
3. Copy it, paste it into the field, click **Save**.
4. Click **Test connection** to confirm.

The key page is a normal browser window with its own persistent session, so you stay signed in to
the vendor between launches. The key is never scraped out of the page — you copy and paste it,
deliberately. Anything cleverer would mean intercepting a login session that belongs to the vendor,
not to this app.

### GLM: pick the right endpoint first

Z.ai and open.bigmodel.cn are separate platforms with separate accounts, and their keys are not
interchangeable. Choose the endpoint that matches where your key came from **before** testing:

- **Z.ai — International** — pay-as-you-go keys from z.ai
- **Z.ai — Coding Plan** — you subscribe to the GLM Coding Plan
- **Bigmodel — Mainland China** — keys from open.bigmodel.cn

Bigmodel's `{id}.{secret}` keys work as-is; the app detects the format and signs the JWT that
platform requires.

### Importing a key you already have

If a vendor CLI already holds an API key, the login card offers it:

> Found a key in `~/.codex/auth.json`: `sk-pro…f21a` — **Import it**

Nothing is imported until you click. Sources checked:

| Provider | File |
|---|---|
| Claude | `~/.claude.json` (`primaryApiKey`) |
| OpenAI | `~/.codex/auth.json` (`OPENAI_API_KEY`) |
| GLM | `~/.claude/settings.json`, when `ANTHROPIC_BASE_URL` points at Z.ai |

Environment variables are also used automatically when nothing is stored: `ZAI_API_KEY`,
`Z_AI_API_KEY`, `ZHIPUAI_API_KEY`, `GLM_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. The Login
screen shows the source, e.g. `sk-ant…9f3c · from $ANTHROPIC_API_KEY`.

---

## Subscription sign-in

For Claude Pro/Max or ChatGPT Plus/Pro:

1. Install the CLI if the card says it is missing:
   ```bash
   npm install -g @anthropic-ai/claude-code    # Claude
   npm install -g @openai/codex                # OpenAI
   npm install -g @moonshot-ai/kimi-code       # Kimi — binary is `kimi`
   ```
   **The scope matters for Kimi.** Three plausible-looking packages are not the one you want:
   unscoped npm `kimi-cli` is an unrelated 2018 scaffolding tool by a different author; PyPI
   `kimi-cli` and PyPI `kimi-code` are both Moonshot's own but wound-down Python CLI, which
   installs `kimi`, `kimi-cli` and `kimi-code` as aliases of the same legacy program. The current
   one is the npm package `@moonshot-ai/kimi-code`, and its binary is `kimi`.

   The sign-in button runs `claude auth login`, `codex login` or `kimi login` in a terminal tab.
   Kimi's is a device-code flow: it prints a URL and a code rather than opening a browser itself.
2. Set **How requests are sent** to the CLI option.
3. Click **Sign in with Claude** / **Sign in with ChatGPT**. A terminal tab opens running the CLI's
   own login flow, which opens your browser.
4. Complete it in the browser, return to the app. The card shows the account.

### Why it works this way

A Claude Pro or ChatGPT Plus login is not a valid bearer token for the public API. An app that
wanted to use those plans directly would have to impersonate the vendor's own client and hold
credentials it has no business holding.

So GLM Studio doesn't. Sign-in runs the vendor's CLI, which performs the OAuth handshake and stores
the session itself. Tokens are never copied, forwarded, or transmitted anywhere.

### How "signed in" is determined

By asking the CLI, not by reading its credential file:

```
claude auth status --json   →  {"loggedIn":true,"authMethod":"oauth_token",…}
codex login status
```

Three things follow from asking rather than reading. The CLI is the only thing that knows where it
keeps a session — a file today, a keyring tomorrow — so parsing one path would be guessing at an
implementation detail that isn't ours. The answer says *how* it authenticated, which a file cannot:
an `ANTHROPIC_API_KEY` the CLI happened to find is not a Pro/Max subscription, and calling it one
would recommend the wrong transport and then fail the turn. And the question is answered without
this process ever holding a token.

Keys are stripped from the probe's own environment first, so a stray `ANTHROPIC_API_KEY` in your
shell profile cannot mask a subscription that is genuinely there. The answer is cached for 20
seconds and dropped the moment a CLI terminal exits, so signing in updates the card immediately.

A build too old to have those subcommands answers nothing, and the credential file is read as a
fallback — for whether a session exists and whose it is, never for the token.

Kimi Code has `login` but no status command, so there is nothing to ask and it always takes that
fallback: the app checks whether `~/.kimi-code/credentials/kimi-code.json` parses and whether its
`expires_at` has passed. Two fields, and not the tokens sitting beside them. (`.kimi-code`, not
`.kimi` — the latter belongs to the legacy Python CLI.)

### Subscription seats think like chat, not like coding agents

There is a catch worth knowing about, because it is the difference between a useful discussion and
a useless one.

`claude` and `codex` are coding agents. They ship a coding system prompt and a full editing
toolset, and it shows: asked an open question, they reach for the filesystem instead of thinking.
The same model reached as chat reasons noticeably better.

So a chat or roundtable turn does not run them as coding agents. It **replaces** the coding system
prompt (`--system-prompt`, not `--append-system-prompt` — appending leaves the coding framing in
place) and restricts the toolset:

| Where | Tools | Why |
|---|---|---|
| Chat view | none | Pure reasoning. Closest to talking to the model directly. |
| Roundtable seats | `WebSearch`, `WebFetch` only | A discussant should be able to check a claim, not edit your repository. |
| Agent terminal | the CLI's own default | This is where you *want* the coding agent. |

Each CLI enforces that differently, so each gets its own mechanism:

| CLI | How the toolset is cut |
|---|---|
| `claude` | `--restricted --tools` — `""` for none, or the two web tools |
| `kimi` | a generated `--agent-file` — Markdown whose frontmatter `tools:` is an allowlist (empty for none) |
| `codex` | `--sandbox read-only --ignore-user-config` — the shell survives, but nothing it runs can write |

Codex is the weakest of the three, and the table says so rather than implying parity: it has no flag
that empties the toolset. Read-only plus ignoring the user's config is the strongest guarantee it
offers.

The restriction is `--restricted --tools`, and the distinction matters: `--allowedTools` reads like
a restriction and is not one. It is a *permission* allowlist — it auto-approves what it names and
leaves the rest of the toolset in place. Asked directly, a seat launched with
`--allowedTools WebSearch WebFetch` reports **42** available tools, Bash, Edit, Write and Read among
them, pointed at your workspace. With `--restricted --tools WebSearch WebFetch` it reports 2, and a
chat turn (`--tools ""`) reports 0. `--restricted` also makes the CLI ignore your own settings
files, so a permissive allowlist in `~/.claude` cannot put the coding tools back.

Builds too old for `--tools` fall back to `--disallowedTools`, which is a real reduction — Bash,
Edit, Write, Read, Glob, Grep and Task all go — but it is a denylist, so anything a future release
adds arrives enabled. `ToolSearch` and `Skill` are on that list too: they are loaders, and left
enabled they pull the coding tools back in one at a time.

Which flags a given CLI build accepts is probed from its `--help` once per binary, so a build that
predates a flag degrades rather than failing — an unrecognised flag makes the CLI exit non-zero and
loses the turn. (An unrecognised *tool name* is only a warning, so the disallow list can name tools
a given release has renamed or dropped.)

The result: your subscription reaches the model, and the model behaves like the chat model it is.

---

## Where credentials are stored

| What | Where | Protection |
|---|---|---|
| API keys you enter | `~/.config/glm-studio/secrets.json` | Encrypted via OS keyring (libsecret) |
| API keys, no keyring available | same file | base64 in a `0600` file — **obfuscation only** |
| Claude subscription | `~/.claude/.credentials.json` | Managed by Claude Code |
| ChatGPT subscription | `~/.codex/auth.json` | Managed by Codex |
| Kimi subscription | `~/.kimi-code/credentials/kimi-code.json` | Managed by Kimi Code |

Settings → Diagnostics reports which backend is active. If it says `file (obfuscated)`, install
`gnome-keyring` or `kwalletmanager` and restart for real encryption.

Authorization headers are redacted before anything is written to the log.

---

## Troubleshooting

**`401` — "The API key was rejected."**
Wrong platform for the key. For GLM, check the endpoint selector. Otherwise re-copy the key: a
truncated paste is the usual cause.

**`403` — valid key, no access.**
The key is not entitled to that model or endpoint. Coding Plan keys only work on the Coding
endpoint. Try the provider's default model.

**"CLI installed but not signed in."**
The session expired or was never created. Click **Sign in again**, or run `claude auth login` /
`codex login` in your own terminal — the app picks up the result on its next check (every 30
seconds, or click **Re-check**). `claude auth status` shows what the CLI currently thinks, and is
exactly what the app asks.

**"Signed in to Claude Code — switch 'How requests are sent' to use that subscription."**
Not an error. The sign-in worked, but this provider is set to the API-key transport, which cannot
use a subscription. Change **How requests are sent** to the CLI option.

**Sign-in terminal shows nothing.**
The CLI could not start. Check **Settings → Advanced → CLI path**; a desktop-launched app inherits a
minimal `PATH`.

**The key saved but Test connection still fails.**
If the keyring was locked when the key was written, decryption fails later. Unlock it and re-enter
the key. The log at `~/.local/state/glm-studio/glm-studio.log` records decryption failures
explicitly.

**"Claude Code is installed but has no Z.ai key to use."**
The GLM provider is set to the CLI transport, which needs a Z.ai API key to point Claude Code at
Z.ai. Add one under the GLM card — GLM has no subscription sign-in of its own.
