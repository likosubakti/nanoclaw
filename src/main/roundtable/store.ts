import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Room, RoomSummary, Seat } from '@shared/roundtable';
import { defaultModerator, defaultSeats } from '@shared/roundtable';
import { DATA_DIR } from '../store/paths';
import { loadSettings } from '../store/settings';
import { createLogger } from '../util/logger';
import { mkdirSync } from 'node:fs';

const log = createLogger('roundtable:store');

const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

function ensureDir(): void {
  mkdirSync(ROOMS_DIR, { recursive: true, mode: 0o700 });
}

function fileFor(id: string): string {
  // Same guard as the conversation store: an id from the renderer must not be
  // able to escape the directory.
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error('invalid room id');
  return path.join(ROOMS_DIR, `${safe}.json`);
}

export function createRoom(input: { topic: string; seats?: Seat[] }): Room {
  ensureDir();
  const settings = loadSettings();
  const seats =
    input.seats ??
    defaultSeats({
      glm: settings.providers.glm.defaultModel,
      anthropic: settings.providers.anthropic.defaultModel,
      openai: settings.providers.openai.defaultModel,
    }).map((seat) => ({ ...seat, cwd: settings.workspaceDir }));

  const now = Date.now();
  const room: Room = {
    id: randomUUID(),
    title: deriveTitle(input.topic),
    topic: input.topic,
    seats,
    moderator: {
      ...defaultModerator(settings.providers.anthropic.defaultModel),
      cwd: settings.workspaceDir,
    },
    rounds: [],
    status: 'idle',
    requireConsensus: true,
    synthesisSeatId: seats.find((s) => s.enabled)?.id,
    createdAt: now,
    updatedAt: now,
  };
  saveRoom(room);
  return room;
}

export function saveRoom(room: Room): Room {
  ensureDir();
  const next = { ...room, updatedAt: Date.now() };
  writeFileSync(fileFor(next.id), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function getRoom(id: string): Room | null {
  try {
    return JSON.parse(readFileSync(fileFor(id), 'utf8')) as Room;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`room ${id} unreadable`, err);
    return null;
  }
}

export function deleteRoom(id: string): void {
  rmSync(fileFor(id), { force: true });
}

export function listRooms(): RoomSummary[] {
  ensureDir();
  let files: string[];
  try {
    files = readdirSync(ROOMS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const summaries: RoomSummary[] = [];
  for (const file of files) {
    try {
      const room = JSON.parse(readFileSync(path.join(ROOMS_DIR, file), 'utf8')) as Room;
      summaries.push({
        id: room.id,
        title: room.title,
        status: room.status,
        seatCount: room.seats.filter((s) => s.enabled).length,
        roundCount: room.rounds.length,
        consensusReached: room.rounds.some((r) => r.consensus),
        updatedAt: room.updatedAt,
      });
    } catch {
      log.warn(`skipping unreadable room file ${file}`);
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

function deriveTitle(topic: string): string {
  const cleaned = topic.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled discussion';
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

/** Markdown export of a whole discussion, including the research trails. */
export function roomToMarkdown(room: Room): string {
  const seatName = (id: string) => room.seats.find((s) => s.id === id)?.name ?? id;
  const lines: string[] = [
    `# ${room.title}`,
    '',
    `**Topic:** ${room.topic}`,
    '',
    `**Participants:** ${room.seats.filter((s) => s.enabled).map((s) => `${s.name} (${s.provider}/${s.transport}, ${s.model})`).join(', ')}`,
    '',
    `**Status:** ${room.status}${room.rounds.some((r) => r.consensus) ? ' — consensus reached' : ''}`,
    '',
  ];

  for (const round of room.rounds) {
    lines.push(`## Round ${round.index + 1} — ${round.mode}`, '');
    if (round.prompt.trim()) lines.push(`> **Owner:** ${round.prompt.trim()}`, '');

    for (const turn of round.turns) {
      lines.push(`### ${seatName(turn.seatId)}`, '');
      if (turn.status === 'error') {
        lines.push(`_Failed: ${turn.error}_`, '');
        continue;
      }
      if (turn.activity.length) {
        lines.push('<details><summary>Research trail</summary>', '');
        for (const a of turn.activity) {
          const target = a.url ?? a.query ?? a.detail ?? '';
          lines.push(`- \`${a.label}\` ${target}`);
        }
        lines.push('', '</details>', '');
      }
      if (turn.reasoning) {
        lines.push('<details><summary>Thinking</summary>', '', turn.reasoning, '', '</details>', '');
      }
      lines.push(turn.content, '');
    }

    if (round.votes.length) {
      lines.push('**Positions at end of round**', '');
      for (const vote of round.votes) {
        lines.push(`- ${seatName(vote.seatId)}: **${vote.agree ? 'agree' : 'disagree'}** — ${vote.note}`);
      }
      lines.push('');
    }
  }

  if (room.conclusion) lines.push('## Conclusion', '', room.conclusion, '');
  return lines.join('\n');
}
