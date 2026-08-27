# Logging in

Every backend can be reached two ways. Pick per provider on the **Login & Providers** screen.

| | API key | Subscription |
|---|---|---|
| GLM (Z.ai) | ✅ the only option | — |
| Claude | ✅ Anthropic Console | ✅ Claude Pro / Max, via `claude` |
| OpenAI | ✅ OpenAI Platform | ✅ ChatGPT Plus / Pro, via `codex` |

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
   ```
2. Set **How requests are sent** to the CLI option.
3. Click **Sign in with Claude** / **Sign in with ChatGPT**. A terminal tab opens running the CLI's
   own login flow, which opens your browser.
4. Complete it in the browser, return to the app. The card shows the account.

### Why it works this way

A Claude Pro or ChatGPT Plus login is not a valid bearer token for the public API. An app that
wanted to use those plans directly would have to impersonate the vendor's own client and hold
credentials it has no business holding.

So GLM Studio doesn't. Sign-in runs the vendor's CLI, which performs the OAuth handshake and stores
the session itself. GLM Studio reads exactly two things from that store: whether a session exists,
and the account name to display. Tokens are never copied, forwarded, or transmitted anywhere.

The side benefit is that CLI-transport chats can use the agent's tools — reading files, running
commands — which an API-only client cannot do.

---

## Where credentials are stored

| What | Where | Protection |
|---|---|---|
| API keys you enter | `~/.config/glm-studio/secrets.json` | Encrypted via OS keyring (libsecret) |
| API keys, no keyring available | same file | base64 in a `0600` file — **obfuscation only** |
| Claude subscription | `~/.claude/.credentials.json` | Managed by Claude Code |
| ChatGPT subscription | `~/.codex/auth.json` | Managed by Codex |

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
The session expired or was never created. Click **Sign in again**, or run `claude` / `codex login`
in your own terminal — the app picks up the result on its next check (every 30 seconds, or click
**Re-check**).

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
