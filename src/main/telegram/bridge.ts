import type { RoundMode, RoundtableEvent } from '@shared/roundtable';
import { ROUND_MODES } from '@shared/roundtable';
import { getSecret } from '../store/secrets';
import { loadSettings, pairChat } from '../store/settings';
import { createLogger } from '../util/logger';
import { abortRoom, runRound } from '../roundtable/engine';
import { relayToWindow } from '../roundtable/relay';
import { createRoom, getRoom, listRooms } from '../roundtable/store';
import { esc, getMe, getUpdates, sendMessage, TelegramError, type TelegramUpdate } from './api';
import { MAX_PAIR_ATTEMPTS, PairingCode, PAIRING_TTL_MS } from './pairing';

export { PAIRING_TTL_MS };

const log = createLogger('telegram');

/**
 * Telegram bridge: watch a discussion and start rounds from a phone.
 *
 * Security model. A bot token is not a secret from the people who can find the
 * bot — anyone who knows its username can message it. So the bridge answers
 * nobody by default. The app shows a pairing code, and only a chat that sends
 * that code is added to the allow list and can thereafter drive rooms.
 * Unpaired chats get a single refusal and are otherwise ignored.
 *
 * The code is genuinely one-time. It is six digits — 900,000 possibilities,
 * and the bot answers every guess, so it is its own oracle — which is only
 * safe because a code dies the moment it is used, ten minutes after it is
 * issued, or after five wrong guesses, whichever comes first. A code that
 * merely rotated per launch would be a static shared secret for the machine's
 * uptime, and what it unlocks is total: every discussion, every transcript,
 * and unmetered spending on the owner's plans.
 *
 * Turn text is posted as each turn completes rather than streamed: Telegram
 * rate-limits edits, and a token-by-token mirror would be throttled into
 * uselessness. Live progress is conveyed by short status lines instead.
 */

type Status = 'stopped' | 'starting' | 'running' | 'error';

interface BridgeState {
  status: Status;
  username?: string;
  error?: string;
  /** Chats already told the bot is private, so they are told exactly once. */
  refused: Set<number>;
  /** The room a given chat is currently driving. */
  activeRoom: Map<number, string>;
  activeMode: Map<number, RoundMode>;
}

const pairing = new PairingCode();

const state: BridgeState = {
  status: 'stopped',
  refused: new Set(),
  activeRoom: new Map(),
  activeMode: new Map(),
};

/** A cap so a flood of strangers cannot grow the refusal set without bound. */
const MAX_REFUSED = 500;

let controller: AbortController | null = null;
let offset = 0;
/** The token `pollLoop` is actually polling with, so a change can be noticed. */
let activeToken: string | null = null;

/** Issues a fresh pairing code and invalidates whatever came before it. */
export function rotatePairingCode(): string {
  return pairing.issue();
}

/** Called when a chat is unpaired: it must not be able to simply re-pair. */
export function revokePairingCode(): void {
  pairing.revoke();
}

export function bridgeStatus(): {
  status: Status;
  username?: string;
  error?: string;
  pairingCode: string;
  allowedChatIds: number[];
} {
  return {
    status: state.status,
    username: state.username,
    error: state.error,
    pairingCode: pairing.live(),
    allowedChatIds: loadSettings().telegram.allowedChatIds,
  };
}

export async function startBridge(): Promise<{ ok: boolean; message: string }> {
  const saved = getSecret('telegram.botToken');

  if (state.status === 'running' || state.status === 'starting') {
    // A token saved while the bridge runs never reached the poll loop, which
    // captured its token as a parameter — so the bridge listened as the old bot
    // and mirrored as the new one, and a revoked token left it permanently deaf
    // while Settings still showed "Connected".
    if (saved && saved === activeToken) {
      return { ok: true, message: `Already connected as @${state.username ?? '…'}.` };
    }
    log.info('bot token changed, rebinding the bridge');
    stopBridge();
  }

  const token = saved;
  if (!token) {
    state.status = 'error';
    state.error = 'No bot token saved.';
    return { ok: false, message: 'Add a bot token first — talk to @BotFather to create one.' };
  }

  state.status = 'starting';
  state.error = undefined;
  rotatePairingCode();

  try {
    const me = await getMe(token);
    state.username = me.username;
  } catch (err) {
    state.status = 'error';
    state.error = (err as Error).message;
    return { ok: false, message: `Could not reach Telegram: ${state.error}` };
  }

  controller = new AbortController();
  activeToken = token;
  state.status = 'running';
  void pollLoop(token, controller.signal);

  // Never the pairing code: it is a live credential, and the log outlives it.
  log.info(`bridge running as @${state.username}`);
  // The code is not in this message either. It is a live credential, the
  // message is echoed into the log on the auto-start path, and the Settings
  // screen shows the code from `bridgeStatus()` anyway.
  return { ok: true, message: `Connected as @${state.username}.` };
}

export function stopBridge(): void {
  controller?.abort();
  controller = null;
  activeToken = null;
  // A different bot numbers its updates independently, so a carried-over
  // cursor would filter out the new bot's first messages.
  offset = 0;
  state.status = 'stopped';
  state.activeRoom.clear();
  state.refused.clear();
  revokePairingCode();
  log.info('bridge stopped');
}

/* ------------------------------------------------------------- polling --- */

async function pollLoop(token: string, signal: AbortSignal): Promise<void> {
  let backoff = 1000;

  while (!signal.aborted) {
    try {
      const updates = await getUpdates(token, offset, 25, signal);
      backoff = 1000;

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await handleUpdate(token, update);
        } catch (err) {
          log.warn('update handler failed', err);
        }
      }
    } catch (err) {
      if (signal.aborted) break;

      // A 409 means another process is polling the same bot; that will never
      // resolve by retrying faster, and hammering it makes it worse.
      if (err instanceof TelegramError && err.code === 409) {
        state.status = 'error';
        state.error = 'Another program is already polling this bot token.';
        log.error(state.error);
        return;
      }

      log.warn(`poll failed, retrying in ${backoff}ms: ${(err as Error).message}`);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/* ------------------------------------------------------------ commands --- */

async function handleUpdate(token: string, update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  const text = message?.text?.trim();
  if (!message || !text) return;

  const chatId = message.chat.id;
  const settings = loadSettings();
  const allowed = settings.telegram.allowedChatIds.includes(chatId);

  // Pairing is the only thing an unpaired chat may do.
  if (!allowed) {
    const pair = /^\/pair(?:@\w+)?\s+(\d{6})$/.exec(text);
    const hadCode = Boolean(pairing.live());

    // `check` consumes the code on success and burns it after enough wrong
    // guesses: the bot answers every guess, so it is an oracle over 900,000
    // codes, and the attacker's patience is not the resource worth exhausting.
    if (pair && pairing.check(pair[1])) {
      pairChat(chatId);
      log.info(`paired chat ${chatId}`);
      await sendMessage(
        token,
        chatId,
        [
          '<b>Paired.</b> This chat can now drive GLM Studio.',
          '',
          'Commands:',
          '/rooms — list discussions',
          '/new &lt;topic&gt; — open a discussion',
          '/open &lt;number&gt; — switch to a discussion',
          '/mode &lt;name&gt; — set the round protocol',
          '/say &lt;text&gt; — run a round (or just send a message)',
          '/wrapup — ask for the conclusion',
          '/stop — abort the running round',
          '/status — what the room is doing',
        ].join('\n'),
      );
      return;
    }

    if (pair && hadCode && !pairing.live()) {
      log.warn(`pairing code revoked after ${MAX_PAIR_ATTEMPTS} wrong guesses`);
    }

    // One refusal, then silence. Nothing recorded that a chat had been told,
    // so a stranger sending /start in a loop got a reply every time — each one
    // a full round trip inside the serially-awaited poll loop, which delays the
    // owner's own /stop behind the flood.
    if (/^\/(start|pair|help)/.test(text) && !state.refused.has(chatId)) {
      if (state.refused.size >= MAX_REFUSED) state.refused.clear();
      state.refused.add(chatId);
      await sendMessage(token, chatId, 'This bot is private. Send /pair with the code shown in GLM Studio.');
    }
    return;
  }

  await handleCommand(token, chatId, text);
}

async function handleCommand(token: string, chatId: number, text: string): Promise<void> {
  const say = (body: string) => sendMessage(token, chatId, body);
  const [, command = '', rest = ''] = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text) ?? [];

  switch (command) {
    case 'rooms': {
      const rooms = listRooms().slice(0, 15);
      if (rooms.length === 0) return say('No discussions yet. Use /new &lt;topic&gt;.');
      return say(
        ['<b>Discussions</b>', '', ...rooms.map((r, i) =>
          `${i + 1}. ${esc(r.title)} — ${r.roundCount} rounds${r.consensusReached ? ', concluded' : ''}`,
        )].join('\n'),
      );
    }

    case 'new': {
      if (!rest.trim()) return say('Give it a topic: /new Should we migrate to SQLite?');
      const room = createRoom({ topic: rest.trim() });
      state.activeRoom.set(chatId, room.id);
      return say(
        `<b>Opened:</b> ${esc(room.title)}\n${room.seats.filter((s) => s.enabled).length} seats. Send a message to start the first round.`,
      );
    }

    case 'open': {
      const index = Number(rest.trim()) - 1;
      const rooms = listRooms();
      const target = rooms[index];
      if (!target) return say('No discussion with that number. Try /rooms.');
      state.activeRoom.set(chatId, target.id);
      return say(`Now following <b>${esc(target.title)}</b>.`);
    }

    case 'mode': {
      const wanted = rest.trim().toLowerCase();
      const match = ROUND_MODES.find(
        (m) => m.mode === wanted || m.label.toLowerCase() === wanted,
      );
      if (!match) {
        return say(
          `Modes: ${ROUND_MODES.map((m) => `<code>${m.mode}</code> (${m.label})`).join(', ')}`,
        );
      }
      state.activeMode.set(chatId, match.mode);
      return say(`Next round: <b>${match.label}</b> — ${esc(match.hint)}`);
    }

    case 'stop': {
      const roomId = state.activeRoom.get(chatId);
      if (!roomId) return say('No discussion selected.');
      return say(abortRoom(roomId) ? 'Stopping the round.' : 'Nothing is running.');
    }

    case 'status': {
      const roomId = state.activeRoom.get(chatId);
      const room = roomId ? getRoom(roomId) : null;
      if (!room) return say('No discussion selected. Use /rooms then /open &lt;number&gt;.');
      const last = room.rounds[room.rounds.length - 1];
      return say(
        [
          `<b>${esc(room.title)}</b>`,
          `${room.rounds.length} rounds · ${room.seats.filter((s) => s.enabled).length} seats · ${room.status}`,
          last?.verdict
            ? `Moderator: ${last.verdict.conclude ? 'concluded' : 'continuing'} — ${esc(last.verdict.reason)}`
            : '',
          `Next round mode: ${state.activeMode.get(chatId) ?? 'parallel'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    case 'wrapup':
      return startRound(token, chatId, 'synthesis', rest.trim());

    case 'say':
      return startRound(token, chatId, state.activeMode.get(chatId) ?? 'parallel', rest.trim());

    case 'help':
    case 'start':
      return say('Already paired. Try /rooms, /new, /say, /mode, /wrapup, /stop, /status.');

    default:
      // Anything that is not a command is treated as something said to the room.
      if (text.startsWith('/')) return say('Unknown command. Try /help.');
      return startRound(token, chatId, state.activeMode.get(chatId) ?? 'parallel', text);
  }
}

async function startRound(
  token: string,
  chatId: number,
  mode: RoundMode,
  message: string,
): Promise<void> {
  const roomId = state.activeRoom.get(chatId) ?? listRooms()[0]?.id;
  if (!roomId) {
    await sendMessage(token, chatId, 'No discussion open. Use /new &lt;topic&gt;.');
    return;
  }
  state.activeRoom.set(chatId, roomId);

  const needsMessage = mode !== 'critique' && mode !== 'synthesis';
  if (needsMessage && !message) {
    await sendMessage(token, chatId, 'Say something for the room to work on.');
    return;
  }

  await sendMessage(
    token,
    chatId,
    `<b>Round starting</b> — ${ROUND_MODES.find((m) => m.mode === mode)?.label ?? mode}`,
  );

  // Fire and forget: the round posts its own progress through the broadcaster,
  // back to the chat that asked. Without the chatId it went to the global sink
  // — the first chat ever paired — so whoever started the round saw nothing
  // after "Round starting", and a private topic surfaced in a team group.
  void runRound({ roomId, mode, message }, (event) => {
    // The app may have the same room open. Without this it never learned the
    // round had started, so it stayed unlocked and a seat edit made during the
    // round overwrote the room file the engine was still writing.
    relayToWindow(event);
    void broadcast(event, chatId);
  });
}

/* ----------------------------------------------------------- broadcast --- */

/**
 * Mirrors round progress to a paired chat.
 *
 * Deliberately coarse. Only events a person reading on a phone would want are
 * posted — who is speaking, what they searched, what they concluded — because
 * every post costs a round trip and Telegram throttles chatty bots.
 *
 * `to` is the chat that asked. Rounds started in the app have no such chat, so
 * they fall back to the configured sink.
 */
export async function broadcast(event: RoundtableEvent, to?: number): Promise<void> {
  const settings = loadSettings();
  if (!settings.telegram.enabled || state.status !== 'running') return;

  const chatId =
    to && settings.telegram.allowedChatIds.includes(to)
      ? to
      : (settings.telegram.broadcastChatId ?? settings.telegram.allowedChatIds[0]);
  if (!chatId) return;

  const token = getSecret('telegram.botToken');
  if (!token) return;

  const text = formatEvent(event);
  if (!text) return;

  try {
    await sendMessage(token, chatId, text);
  } catch (err) {
    log.debug('broadcast failed', err);
  }
}

export function formatEvent(event: RoundtableEvent): string | null {
  switch (event.type) {
    case 'moderator-brief':
      return [
        '🎙 <b>Moderator brief</b>',
        '',
        esc(truncate(event.brief.agenda, 900)),
        event.brief.notes ? `\n<i>${esc(truncate(event.brief.notes, 300))}</i>` : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'turn-end': {
      const seat = getRoom(event.roomId)?.seats.find((s) => s.id === event.seatId);
      if (!seat) return null;

      if (event.status === 'error') {
        return `⚠️ <b>${esc(seat.name)}</b> could not answer — ${esc(truncate(event.error ?? '', 200))}`;
      }

      // The answer rides on the event. Reading it back out of the store, as
      // this did, could never work: the engine pushes turns into the round
      // only after every turn has finished, so at this instant the turn is on
      // neither disk nor the room — and so the mirror posted the failures and
      // never a single answer.
      const content = event.content?.trim();
      if (!content) return null;

      const trail = (event.activity ?? [])
        .slice(0, 6)
        .map((a) => `· ${a.kind} ${esc(truncate(a.query ?? a.url ?? a.detail ?? '', 70))}`)
        .join('\n');

      return [
        `<b>${esc(seat.name)}</b>${seat.role ? ` <i>(${esc(truncate(seat.role, 60))})</i>` : ''}`,
        trail ? `<pre>${trail}</pre>` : '',
        // Not truncated here: sendMessage splits at paragraph boundaries, which
        // is what the docs promise. The cap is a runaway guard, not a limit.
        esc(truncate(content, 12_000)),
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'moderator-verdict':
      return [
        event.verdict.conclude ? '⚖️ <b>Concluded</b>' : '⚖️ <b>Continuing</b>',
        '',
        esc(truncate(event.verdict.reason, 600)),
        event.verdict.focus ? `\n<b>Next:</b> ${esc(truncate(event.verdict.focus, 300))}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    case 'round-end':
      return `— round ${event.roundIndex + 1} ended · ${event.totals.turns} turns · ${(
        event.totals.inputTokens + event.totals.outputTokens
      ).toLocaleString()} tokens —`;

    case 'room-error':
      return `⚠️ ${esc(event.message)}`;

    default:
      // Token-level events are intentionally not mirrored.
      return null;
  }
}

function truncate(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}
