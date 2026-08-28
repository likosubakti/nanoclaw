import type { ProviderId, Transport } from '@shared/types';
import type { Moderator, Room, Seat } from '@shared/roundtable';

/**
 * Validation for rooms arriving from the renderer.
 *
 * `room:update` receives a whole Room object, which makes it the widest input
 * surface in the app. Trusting it wholesale means a crafted payload can pick
 * the provider that gets spawned, the working directory it runs in, the id it
 * is written under, and the size of everything that reaches a prompt.
 *
 * So nothing is trusted. The existing room is loaded from disk by its own id,
 * and only known fields are folded in — clamped, enumerated, and bounded.
 * Unknown properties are dropped rather than persisted.
 */

/** Control characters would corrupt prompts and the Markdown export alike. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const LIMITS = {
  topic: 8_000,
  title: 200,
  name: 60,
  role: 4_000,
  seats: 16,
  model: 120,
  cwd: 4_096,
};

export class InvalidRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoomError';
  }
}

function str(value: unknown, limit: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(CONTROL_CHARS, '').slice(0, limit);
}

function provider(value: unknown, fallback: ProviderId): ProviderId {
  return value === 'glm' || value === 'anthropic' || value === 'openai' || value === 'kimi' ? value : fallback;
}

function transport(value: unknown, fallback: Transport): Transport {
  return value === 'api' || value === 'cli' ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * A seat's cwd is handed to a spawned CLI, so it must be an absolute path and
 * nothing else — no shell metacharacters, no relative traversal.
 */
function workingDirectory(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback;
  if (value.length > LIMITS.cwd) return fallback;
  if (/\.\.(\/|$)/.test(value)) return fallback;
  return value;
}

function sanitizeSeat(incoming: any, template: Seat): Seat {
  return {
    // Ids are matched against existing seats or generated; never taken raw.
    id: /^[\w-]{1,64}$/.test(String(incoming?.id ?? '')) ? String(incoming.id) : template.id,
    name: str(incoming?.name, LIMITS.name) || template.name,
    provider: provider(incoming?.provider, template.provider),
    transport: transport(incoming?.transport, template.transport),
    model: str(incoming?.model, LIMITS.model) || template.model,
    enabled: incoming?.enabled !== false,
    role: str(incoming?.role, LIMITS.role) || undefined,
    color: color(incoming?.color, template.color),
    cwd: workingDirectory(incoming?.cwd, template.cwd),
  };
}

function sanitizeModerator(incoming: any, template: Moderator): Moderator {
  return {
    enabled: incoming?.enabled !== false,
    name: str(incoming?.name, LIMITS.name) || template.name,
    provider: provider(incoming?.provider, template.provider),
    transport: transport(incoming?.transport, template.transport),
    model: str(incoming?.model, LIMITS.model) || template.model,
    cwd: workingDirectory(incoming?.cwd, template.cwd),
    color: color(incoming?.color, template.color),
    role: str(incoming?.role, LIMITS.role) || undefined,
    creativity: clamp(incoming?.creativity, 0, 1, template.creativity ?? 0.7),
  };
}

/**
 * Folds a renderer-supplied room onto the one already on disk.
 *
 * The transcript (`rounds`) is deliberately NOT taken from the renderer: it is
 * written by the engine, and accepting it would let a crafted payload rewrite
 * history or inject text that later seats read as another participant's words.
 */
export function sanitizeRoom(incoming: unknown, existing: Room): Room {
  const raw = (incoming ?? {}) as any;

  const seatsIn = Array.isArray(raw.seats) ? raw.seats.slice(0, LIMITS.seats) : [];
  const template = existing.seats[0];
  const seats: Seat[] = seatsIn.map((seat: any) => {
    const match = existing.seats.find((s) => s.id === seat?.id);
    return sanitizeSeat(seat, match ?? template);
  });

  if (seats.length === 0) {
    throw new InvalidRoomError('A room needs at least one seat.');
  }

  // Seat names address participants in prompts and are parsed back out of the
  // moderator's brief, so duplicates would make the brief ambiguous.
  const seen = new Set<string>();
  for (const seat of seats) {
    let name = seat.name;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${seat.name} ${n}`;
    seat.name = name;
    seen.add(name.toLowerCase());
  }

  const synthesisSeatId = seats.some((s) => s.id === raw.synthesisSeatId)
    ? String(raw.synthesisSeatId)
    : (seats.find((s) => s.enabled)?.id ?? seats[0].id);

  return {
    // Identity and history stay with the stored room.
    id: existing.id,
    createdAt: existing.createdAt,
    rounds: existing.rounds,
    conclusion: existing.conclusion,

    title: str(raw.title, LIMITS.title) || existing.title,
    topic: str(raw.topic, LIMITS.topic) || existing.topic,
    seats,
    moderator: sanitizeModerator(raw.moderator, existing.moderator),
    status: raw.status === 'closed' || existing.status === 'closed' ? 'closed' : existing.status,
    requireConsensus: raw.requireConsensus !== false,
    synthesisSeatId,
    updatedAt: Date.now(),
  };
}
