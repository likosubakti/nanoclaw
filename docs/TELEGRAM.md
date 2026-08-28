# Telegram bridge

Follow a discussion, and start new rounds, from anywhere. Settings → **Telegram**.

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. It gives you a token.
2. Paste the token into Settings → Telegram and press **Save**. It is stored with your API keys.
3. Turn on **Bridge to Telegram**. The app shows a six-digit pairing code.
4. Message your bot: `/pair 123456`.

That's it. No public URL, no port forwarding, no webhook — the bridge long-polls, so it works from
behind any NAT.

## Why pairing exists

A bot token is not a secret from the people who can find your bot. Anyone who knows its username can
message it. So **the bridge answers nobody by default**: only a chat that has sent the current
pairing code is allowed to drive anything, and the code changes every time the bridge starts, so an
old screenshot cannot pair a chat later.

An unpaired chat gets one refusal and is otherwise ignored — a bot that argues with strangers is a
nuisance to whoever stumbles onto it.

Paired chats can start rounds, and rounds spend tokens. Unpair a chat you no longer control from
Settings.

## Commands

| Command | Effect |
|---|---|
| `/rooms` | List discussions |
| `/new <topic>` | Open a discussion |
| `/open <number>` | Switch to a discussion |
| `/mode <name>` | Set the protocol for the next round |
| `/say <text>` | Run a round — or just send a message, which does the same |
| `/wrapup` | Ask for the conclusion |
| `/stop` | Abort the running round |
| `/status` | What the room is doing |

## What gets mirrored

Rounds started in the app are mirrored to Telegram too, so the phone is a live window on the room
rather than a separate channel.

Posted as they happen: the moderator's brief, each seat's answer with the first few lines of its
research trail, the moderator's ruling, and a round summary with the running token total.

Not posted: token-by-token streaming. Telegram rate-limits chatty bots, and a live mirror would be
throttled into uselessness. Short status lines carry the progress instead.

Long turns are split across messages at paragraph boundaries rather than truncated, and model
output is HTML-escaped — a seat quoting `<script>` would otherwise make Telegram reject the whole
post.
