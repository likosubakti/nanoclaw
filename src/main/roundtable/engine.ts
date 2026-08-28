import { randomUUID } from 'node:crypto';
import type { ChatMessage, StreamEvent } from '@shared/types';
import type {
  ActivityEvent,
  Moderator,
  ModeratorBrief,
  ModeratorVerdict,
  Room,
  RoomTotals,
  Round,
  RoundMode,
  RoundtableEvent,
  Seat,
  Turn,
  Vote,
} from '@shared/roundtable';
import { adapterFor } from '../providers/registry';
import { HttpError } from '../net/http';
import { MissingCredentialsError } from '../providers/types';
import { loadSettings } from '../store/settings';
import { createLogger } from '../util/logger';
import {
  briefPrompt,
  instructionForSeat,
  moderatorSystemPrompt,
  parseBrief,
  parseVerdict,
  renderTranscript,
  seatSystemPrompt,
  verdictPrompt,
  votePrompt,
} from './prompts';
import { getRoom, saveRoom } from './store';
import { foldRound, pickParticipants } from './round-plan';

const log = createLogger('roundtable');

type Emit = (event: RoundtableEvent) => void;

/**
 * Runs discussion rounds.
 *
 * Design notes worth keeping in mind:
 *
 * - Each seat's turn is an independent provider call. Failures are contained to
 *   that seat: one backend being down must not end the discussion, so a failed
 *   turn is recorded and the round continues.
 * - There is no round cap. The owner chose "run until consensus or I close it",
 *   so the engine keeps a running token total and reports it after every round
 *   instead of stopping on a budget.
 * - Every round is persisted as it completes, so closing the app mid-discussion
 *   loses at most the round in flight.
 */

/** Rooms with a round currently running, so they can be aborted. */
const running = new Map<string, AbortController>();

export function isRunning(roomId: string): boolean {
  return running.has(roomId);
}

/**
 * Aborting does not release the lock. A round keeps writing until its seats
 * settle — a CLI seat can take another minute — and dropping the lock here let
 * a second round start on a copy of the room loaded before those writes. Both
 * runs then saved the whole room and the last writer won, destroying a
 * complete round. `runRound`'s `finally` releases the lock once the round has
 * actually returned, which also keeps `isRunning` honest: the composer stays
 * locked and Stop stays visible for the wind-down the toast already promises.
 */
export function abortRoom(roomId: string): boolean {
  const controller = running.get(roomId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function abortAllRooms(): void {
  for (const controller of running.values()) controller.abort();
}

export interface RunRoundInput {
  roomId: string;
  mode: RoundMode;
  /** What the owner said. May be empty for critique and synthesis rounds. */
  message: string;
  /** Restrict the round to these seats. Defaults to every enabled seat. */
  seatIds?: string[];
}

export async function runRound(input: RunRoundInput, emit: Emit): Promise<Room | null> {
  const room = getRoom(input.roomId);
  if (!room) {
    emit({ type: 'room-error', roomId: input.roomId, message: 'Room not found.' });
    return null;
  }
  if (running.has(room.id)) {
    emit({ type: 'room-error', roomId: room.id, message: 'A round is already running.' });
    return room;
  }
  // Enforced here rather than only in the UI: Telegram can start rounds too,
  // and a closed discussion must stay closed whatever asks.
  if (room.status === 'closed') {
    emit({
      type: 'room-error',
      roomId: room.id,
      message: 'This discussion is closed. Open a new one to continue.',
    });
    return room;
  }

  const controller = new AbortController();
  running.set(room.id, controller);

  try {
    return await executeRound(room, input, controller.signal, emit);
  } catch (err) {
    log.error('round failed', err);
    emit({ type: 'room-error', roomId: room.id, message: (err as Error).message });
    return getRoom(room.id);
  } finally {
    running.delete(room.id);
  }
}

/**
 * Persists what the round owns, folded onto the room as it is on disk now.
 *
 * `room` was read when the round started and goes stale the moment anything
 * else writes: `room:close` and `room:update` both operate on their own fresh
 * copy. Saving `room` whole erased them — most damagingly the `closed` status,
 * which is the guard that stops a paired phone restarting a discussion the
 * owner ended.
 */
function persistRound(room: Room): void {
  const stored = getRoom(room.id);
  if (!stored) {
    saveRoom(room);
    return;
  }
  const merged = foldRound(stored, room);
  saveRoom(merged);
  // Keep the in-memory copy honest so the room-status event does not announce
  // 'idle' for a room the owner just closed.
  room.status = merged.status;
}

async function executeRound(
  room: Room,
  input: RunRoundInput,
  signal: AbortSignal,
  emit: Emit,
): Promise<Room> {
  const participants = pickParticipants(room, input.mode, input.seatIds);

  if (participants.length === 0) {
    emit({ type: 'room-error', roomId: room.id, message: 'No seats are enabled for this round.' });
    return room;
  }

  const round: Round = {
    index: room.rounds.length,
    mode: input.mode,
    prompt: input.message,
    seatIds: participants.map((s) => s.id),
    turns: [],
    votes: [],
    consensus: false,
    startedAt: Date.now(),
  };
  room.rounds.push(round);
  room.status = 'running';
  persistRound(room);

  emit({
    type: 'round-start',
    roomId: room.id,
    roundIndex: round.index,
    mode: round.mode,
    seatIds: round.seatIds,
  });
  emit({ type: 'room-status', roomId: room.id, status: 'running' });

  // The moderator turns the owner's rough input into a brief, and tailors it to
  // each seat's role, before anyone speaks. A synthesis round already has its
  // instruction, so it does not need one.
  if (room.moderator.enabled && input.mode !== 'synthesis' && !signal.aborted) {
    round.brief = await runModeratorBrief(room, round, input.message, signal, emit);
    persistRound(room);
  }

  // 'parallel' is the only mode where seats genuinely cannot see each other, so
  // it is the only one that runs concurrently. Everything else is a
  // conversation, and a conversation has to be ordered.
  if (input.mode === 'parallel') {
    // The brief runs first on every round and can take a minute, so Stop lands
    // here often. Without this the whole roster was launched into an aborted
    // round, and a CLI seat spawned after an abort is never killed — it runs a
    // full billed turn nobody asked for.
    if (!signal.aborted) {
      const turns = await Promise.all(
        participants.map((seat) => runTurn(room, round, seat, signal, emit)),
      );
      round.turns.push(...turns);
    }
  } else {
    for (const seat of participants) {
      if (signal.aborted) break;
      round.turns.push(await runTurn(room, round, seat, signal, emit));
    }
  }

  round.endedAt = Date.now();
  persistRound(room);

  // Who decides the discussion is over. A seated moderator is the judge — that
  // is what it is for. Seat voting is the fallback when there is no moderator,
  // so a room without one can still converge on its own.
  const deliberated = round.turns.some((t) => t.status === 'done');
  const canJudge = !signal.aborted && input.mode !== 'synthesis' && deliberated;

  if (canJudge && room.moderator.enabled) {
    round.verdict = await runModeratorVerdict(room, round, signal, emit);
    round.consensus = round.verdict.conclude;
  } else if (canJudge && room.requireConsensus) {
    round.votes = await collectVotes(room, round, participants, signal, emit);
    round.consensus =
      round.votes.length > 0 && round.votes.every((v) => v.agree) && round.votes.length > 1;
  }

  if (input.mode === 'synthesis') {
    const conclusion = round.turns.find((t) => t.status === 'done')?.content;
    if (conclusion) room.conclusion = conclusion;
  }

  room.status = 'idle';
  persistRound(room);

  emit({
    type: 'round-end',
    roomId: room.id,
    roundIndex: round.index,
    consensus: round.consensus,
    totals: totalsFor(room),
  });
  emit({ type: 'room-status', roomId: room.id, status: room.status, conclusion: room.conclusion });

  return room;
}

/* --------------------------------------------------------------- a turn --- */

async function runTurn(
  room: Room,
  round: Round,
  seat: Seat,
  signal: AbortSignal,
  emit: Emit,
): Promise<Turn> {
  const turn: Turn = {
    id: randomUUID(),
    seatId: seat.id,
    roundIndex: round.index,
    content: '',
    activity: [],
    status: 'streaming',
    startedAt: Date.now(),
  };

  emit({
    type: 'turn-start',
    roomId: room.id,
    roundIndex: round.index,
    seatId: seat.id,
    turnId: turn.id,
  });

  const settings = loadSettings();
  const transcript = renderTranscript(room, round.index, turn.id);
  const instruction = instructionForSeat(round.mode, round, seat);

  // Full transcript on every turn, uncapped, as chosen for this room.
  const userContent = transcript
    ? `Discussion so far:\n\n${transcript}\n\n---\n\n${instruction}`
    : instruction;

  const messages: ChatMessage[] = [
    { id: randomUUID(), role: 'user', content: userContent, createdAt: Date.now() },
  ];

  let reasoning = '';

  const onEvent = (event: StreamEvent) => {
    switch (event.type) {
      case 'text':
        turn.content += event.text;
        emit({ type: 'turn-text', roomId: room.id, turnId: turn.id, seatId: seat.id, text: event.text });
        break;
      case 'reasoning':
        reasoning += event.text;
        emit({
          type: 'turn-reasoning',
          roomId: room.id,
          turnId: turn.id,
          seatId: seat.id,
          text: event.text,
        });
        break;
      case 'tool': {
        const activity = toActivity(event);
        turn.activity.push(activity);
        emit({ type: 'turn-activity', roomId: room.id, turnId: turn.id, seatId: seat.id, activity });
        break;
      }
      case 'usage':
        turn.meta = {
          provider: seat.provider,
          model: seat.model,
          transport: seat.transport,
          ...turn.meta,
          inputTokens: event.inputTokens ?? turn.meta?.inputTokens,
          outputTokens: event.outputTokens ?? turn.meta?.outputTokens,
        };
        break;
      default:
        break;
    }
  };

  try {
    const adapter = adapterFor(seat.provider, seat.transport);
    await adapter.stream(
      {
        conversationId: room.id,
        provider: seat.provider,
        model: seat.model,
        transport: seat.transport,
        messages,
        systemPrompt: seatSystemPrompt(room, seat),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        thinking: settings.thinking,
        cwd: seat.cwd ?? settings.workspaceDir,
        // A discussion wants the model's judgement, not a coding agent. CLI
        // seats keep web search so they can still check a claim.
        toolPolicy: 'research',
      },
      { streamId: turn.id, signal, emit: onEvent },
    );

    turn.status = signal.aborted ? 'aborted' : 'done';
  } catch (err) {
    // One backend failing must not end the discussion — record it and let the
    // other seats carry the round.
    turn.status = signal.aborted ? 'aborted' : 'error';
    turn.error = describeSeatError(err);
    log.warn(`seat ${seat.name} failed: ${turn.error}`);
  }

  if (reasoning) turn.reasoning = reasoning;
  turn.endedAt = Date.now();
  turn.meta = {
    provider: seat.provider,
    model: seat.model,
    transport: seat.transport,
    ...turn.meta,
    durationMs: turn.endedAt - turn.startedAt,
  };

  emit({
    type: 'turn-end',
    roomId: room.id,
    turnId: turn.id,
    seatId: seat.id,
    status: turn.status,
    meta: turn.meta,
    error: turn.error,
  });

  return turn;
}

/* ------------------------------------------------------------- consensus -- */

async function collectVotes(
  room: Room,
  round: Round,
  participants: Seat[],
  signal: AbortSignal,
  emit: Emit,
): Promise<Vote[]> {
  const settings = loadSettings();
  const transcript = renderTranscript(room, round.index);
  const votes: Vote[] = [];

  // Votes are independent of each other, so they run together. Only seats that
  // actually spoke this round get a say.
  const voters = participants.filter((seat) =>
    round.turns.some((t) => t.seatId === seat.id && t.status === 'done'),
  );

  await Promise.all(
    voters.map(async (seat) => {
      let reply = '';
      try {
        const adapter = adapterFor(seat.provider, seat.transport);
        await adapter.stream(
          {
            conversationId: `${room.id}-vote-${round.index}`,
            provider: seat.provider,
            model: seat.model,
            transport: seat.transport,
            messages: [
              {
                id: randomUUID(),
                role: 'user',
                content: `Discussion so far:\n\n${transcript}\n\n---\n\n${votePrompt(room)}`,
                createdAt: Date.now(),
              },
            ],
            systemPrompt: seatSystemPrompt(room, seat),
            // Deliberately small: this runs after every round.
            maxTokens: 200,
            temperature: 0,
            thinking: false,
            cwd: seat.cwd ?? settings.workspaceDir,
            // A one-line vote needs no tools at all.
            toolPolicy: 'none',
          },
          {
            streamId: `${round.index}-${seat.id}-vote`,
            signal,
            emit: (event) => {
              if (event.type === 'text') reply += event.text;
            },
          },
        );
      } catch (err) {
        log.debug(`vote from ${seat.name} failed`, err);
      }

      const vote = parseVote(seat.id, reply);
      votes.push(vote);
      emit({ type: 'vote', roomId: room.id, roundIndex: round.index, vote });
    }),
  );

  // Keep the tally in seat order so the UI does not shuffle between rounds.
  return participants
    .map((seat) => votes.find((v) => v.seatId === seat.id))
    .filter((v): v is Vote => Boolean(v));
}

/**
 * Reads a vote out of a free-text reply.
 *
 * A seat that cannot be parsed counts as disagreeing. That is the safe default:
 * it keeps the discussion going rather than declaring a consensus nobody
 * actually expressed.
 */
export function parseVote(seatId: string, reply: string): Vote {
  const text = reply.trim();
  const match = /\b(AGREE|DISAGREE)\b\s*[:\-—]?\s*(.*)/is.exec(text);

  if (!match) {
    return {
      seatId,
      agree: false,
      note: text ? truncate(text.split('\n')[0], 160) : 'No response to the consensus check.',
    };
  }

  return {
    seatId,
    agree: match[1].toUpperCase() === 'AGREE',
    note: truncate(match[2].trim().split('\n')[0] || '(no reason given)', 160),
  };
}

/* --------------------------------------------------------------- helpers -- */

export function toActivity(event: Extract<StreamEvent, { type: 'tool' }>): ActivityEvent {
  const kind: ActivityEvent['kind'] = event.url
    ? 'fetch'
    : event.query
      ? 'search'
      : /^(read|write|edit|grep|glob)$/i.test(event.name)
        ? 'read'
        : /^(bash|shell)$/i.test(event.name)
          ? 'run'
          : 'tool';

  return {
    at: Date.now(),
    kind,
    label: event.name,
    query: event.query,
    url: event.url,
    detail: event.detail,
  };
}

export function totalsFor(room: Room): RoomTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  for (const round of room.rounds) {
    for (const turn of round.turns) {
      turns++;
      inputTokens += turn.meta?.inputTokens ?? 0;
      outputTokens += turn.meta?.outputTokens ?? 0;
    }
  }
  return { inputTokens, outputTokens, turns, rounds: room.rounds.length };
}

function describeSeatError(err: unknown): string {
  if (err instanceof MissingCredentialsError) return err.hint;
  if (err instanceof HttpError) {
    const { message, hint } = err.friendly;
    return hint ? `${message} ${hint}` : message;
  }
  return (err as Error)?.message ?? String(err);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/* -------------------------------------------------------------- moderator -- */

interface ModeratorResult {
  text: string;
  reasoning: string;
  activity: ActivityEvent[];
  failed?: string;
}

/**
 * Runs one moderator turn.
 *
 * Its thinking and research stream to the UI exactly like a seat's do — the
 * owner asked to see the moderator work, and a judge whose reasoning is hidden
 * is just an oracle.
 */
async function runModeratorTurn(
  room: Room,
  moderator: Moderator,
  roundIndex: number,
  phase: 'brief' | 'verdict',
  userContent: string,
  signal: AbortSignal,
  emit: Emit,
): Promise<ModeratorResult> {
  emit({ type: 'moderator-start', roomId: room.id, roundIndex, phase });

  const settings = loadSettings();
  const result: ModeratorResult = { text: '', reasoning: '', activity: [] };

  try {
    const adapter = adapterFor(moderator.provider, moderator.transport);
    await adapter.stream(
      {
        conversationId: `${room.id}-mod-${roundIndex}-${phase}`,
        provider: moderator.provider,
        model: moderator.model,
        transport: moderator.transport,
        messages: [
          { id: randomUUID(), role: 'user', content: userContent, createdAt: Date.now() },
        ],
        systemPrompt: moderatorSystemPrompt(room),
        // A brief written at temperature 0 is the same brief every time, which
        // is exactly the staleness the creativity dial exists to avoid. The
        // ruling phase wants less variance than the briefing phase.
        temperature:
          phase === 'brief'
            ? Math.min(1, Math.max(0, moderator.creativity ?? 0.7))
            : Math.min(0.4, (moderator.creativity ?? 0.7) * 0.4),
        maxTokens: settings.maxTokens,
        thinking: settings.thinking,
        cwd: moderator.cwd ?? settings.workspaceDir,
        toolPolicy: 'research',
      },
      {
        streamId: `${room.id}-mod-${roundIndex}-${phase}`,
        signal,
        emit: (event) => {
          switch (event.type) {
            case 'text':
              result.text += event.text;
              emit({ type: 'moderator-text', roomId: room.id, roundIndex, text: event.text });
              break;
            case 'reasoning':
              result.reasoning += event.text;
              emit({ type: 'moderator-reasoning', roomId: room.id, roundIndex, text: event.text });
              break;
            case 'tool': {
              const activity = toActivity(event);
              result.activity.push(activity);
              emit({ type: 'moderator-activity', roomId: room.id, roundIndex, activity });
              break;
            }
            default:
              break;
          }
        },
      },
    );
  } catch (err) {
    // The moderator is scaffolding. If it falls over, the round still runs —
    // seats fall back to the un-tailored instruction and the room keeps going.
    result.failed = describeSeatError(err);
    log.warn(`moderator ${phase} failed: ${result.failed}`);
  }

  return result;
}

async function runModeratorBrief(
  room: Room,
  round: Round,
  ownerMessage: string,
  signal: AbortSignal,
  emit: Emit,
): Promise<ModeratorBrief | undefined> {
  const transcript = renderTranscript(room, round.index - 1);
  const { prompt, framing } = briefPrompt(room, ownerMessage, round.mode);
  const content = transcript
    ? `Discussion so far:\n\n${transcript}\n\n---\n\n${prompt}`
    : prompt;

  const result = await runModeratorTurn(
    room,
    room.moderator,
    round.index,
    'brief',
    content,
    signal,
    emit,
  );

  if (result.failed || !result.text.trim()) return undefined;

  const parsed = parseBrief(room, result.text);
  const brief: ModeratorBrief = {
    ...parsed,
    // Recorded so later rounds can avoid reaching for the same lens twice.
    framing,
    reasoning: result.reasoning || undefined,
    activity: result.activity,
  };
  emit({ type: 'moderator-brief', roomId: room.id, roundIndex: round.index, brief });
  return brief;
}

async function runModeratorVerdict(
  room: Room,
  round: Round,
  signal: AbortSignal,
  emit: Emit,
): Promise<ModeratorVerdict> {
  const transcript = renderTranscript(room, round.index);
  const result = await runModeratorTurn(
    room,
    room.moderator,
    round.index,
    'verdict',
    `Discussion so far:\n\n${transcript}\n\n---\n\n${verdictPrompt(room)}`,
    signal,
    emit,
  );

  const parsed = result.failed
    ? {
        conclude: false,
        reason: `The moderator could not rule: ${result.failed}`,
        focus: undefined,
      }
    : parseVerdict(result.text);

  const verdict: ModeratorVerdict = {
    ...parsed,
    reasoning: result.reasoning || undefined,
    activity: result.activity,
  };
  emit({ type: 'moderator-verdict', roomId: room.id, roundIndex: round.index, verdict });
  return verdict;
}
