import { randomInt } from 'node:crypto';
import type { RoundMode, RoundtableEvent } from '@shared/roundtable';
import { ROUND_MODES } from '@shared/roundtable';
import { getSecret } from '../store/secrets';
import { loadSettings, saveSettings } from '../store/settings';
import { createLogger } from '../util/logger';
import { abortRoom, runRound } from '../roundtable/engine';
import { createRoom, getRoom, listRooms } from '../roundtable/store';
import { esc, getMe, getUpdates, sendMessage, TelegramError, type TelegramUpdate } from './api';

const log = createLogger('telegram');

/**
 * Telegram bridge: watch a discussion and start rounds from a phone.
 *
 * Security model. A bot token is not a secret from the people who can find the
 * bot — anyone who knows its username can message it. So the bridge answers
 * nobody by default. The app shows a one-time pairing code, and only a chat
 * that sends that code is added to the allow list and can thereafter drive
 * rooms. Unpaired chats get a single refusal and are otherwise ignored.
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
  /** The code the user must send to pair a chat. Rotates on each start. */
  pairingCode: string;
  /** The room a given chat is currently driving. */
  activeRoom: Map<number, string>;
  activeMode: Map<number, RoundMode>;
}

const state: BridgeState = {
  status: 'stopped',
  pairingCode: '',
  activeRoom: new Map(),
  activeMode: new Map(),
};

let controller: AbortController | null = null;
let offset = 0;

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
    pairingCode: state.pairingCode,
    allowedChatIds: loadSettings().telegram.allowedChatIds,
  };
}

export async function startBridge(): Promise<{ ok: boolean; message: string }> {
  if (state.status === 'running' || state.status === 'starting') {
    return { ok: true, message: `Already connected as @${state.username ?? '…'}.` };
  }

  const token = getSecret('telegram.botToken');
  if (!token) {
    state.status = 'error';
    state.error = 'No bot token saved.';
    return { ok: false, message: 'Add a bot token first — talk to @BotFather to create one.' };
  }

  state.status = 'starting';
  state.error = undefined;
  // A fresh code per session, so an old screenshot cannot pair a chat later.
  state.pairingCode = String(randomInt(100_000, 999_999));

  try {
    const me = await getMe(token);
    state.username = me.username;
  } catch (err) {
    state.status = 'error';
    state.error = (err as Error).message;
    return { ok: false, message: `Could not reach Telegram: ${state.error}` };
  }

  controller = new AbortController();
  state.status = 'running';
  void pollLoop(token, controller.signal);

  log.info(`bridge running as @${state.username}`);
  return { ok: true, message: `Connected as @${state.username}. Send /pair ${state.pairingCode} to your bot.` };
}

export function stopBridge(): void {
  controller?.abort();
  controller = null;
  state.status = 'stopped';
  state.activeRoom.clear();
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
    if (pair && state.pairingCode && pair[1] === state.pairingCode) {
      saveSettings({
        telegram: {
          ...settings.telegram,
          allowedChatIds: [...settings.telegram.allowedChatIds, chatId],
          broadcastChatId: settings.telegram.broadcastChatId ?? chatId,
        },
      });
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

    // One refusal, then silence — an unpaired chat should not get a reply per
    // message, which would make the bot a nuisance to whoever found it.
    if (/^\/(start|pair|help)/.test(text)) {
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

  // Fire and forget: the round posts its own progress through the broadcaster.
  void runRound({ roomId, mode, message }, (event) => void broadcast(event));
}

/* ----------------------------------------------------------- broadcast --- */

/**
 * Mirrors round progress to the paired chat.
 *
 * Deliberately coarse. Only events a person reading on a phone would want are
 * posted — who is speaking, what they searched, what they concluded — because
 * every post costs a round trip and Telegram throttles chatty bots.
 */
export async function broadcast(event: RoundtableEvent): Promise<void> {
  const settings = loadSettings();
  if (!settings.telegram.enabled || state.status !== 'running') return;

  const chatId = settings.telegram.broadcastChatId ?? settings.telegram.allowedChatIds[0];
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
      const room = getRoom(event.roomId);
      const seat = room?.seats.find((s) => s.id === event.seatId);
      const turn = room?.rounds.flatMap((r) => r.turns).find((t) => t.id === event.turnId);
      if (!seat) return null;

      if (event.status === 'error') {
        return `⚠️ <b>${esc(seat.name)}</b> could not answer — ${esc(truncate(event.error ?? '', 200))}`;
      }
      if (!turn?.content.trim()) return null;

      const trail = turn.activity
        .slice(0, 6)
        .map((a) => `· ${a.kind} ${esc(truncate(a.query ?? a.url ?? a.detail ?? '', 70))}`)
        .join('\n');

      return [
        `<b>${esc(seat.name)}</b>${seat.role ? ` <i>(${esc(truncate(seat.role, 60))})</i>` : ''}`,
        trail ? `<pre>${trail}</pre>` : '',
        esc(truncate(turn.content, 2500)),
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
