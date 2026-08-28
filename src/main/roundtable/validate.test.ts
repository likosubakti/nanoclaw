import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Room, Seat } from '@shared/roundtable';
import { InvalidRoomError, sanitizeRoom } from './validate';

/**
 * `room:update` takes a whole Room from the renderer, which makes it the widest
 * input surface in the app: the payload names the provider that gets spawned,
 * the directory it runs in, and the text that reaches every prompt. These tests
 * pin the rule that nothing crosses that boundary unvalidated.
 */

function seat(over: Partial<Seat> = {}): Seat {
  return {
    id: 'seat-1',
    name: 'GLM',
    provider: 'glm',
    transport: 'api',
    model: 'glm-4.6',
    enabled: true,
    color: '#38bdf8',
    cwd: '/home/user/projects',
    ...over,
  };
}

function room(over: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    title: 'Stored title',
    topic: 'Stored topic',
    seats: [seat()],
    moderator: {
      enabled: true,
      name: 'Moderator',
      provider: 'anthropic',
      transport: 'cli',
      model: 'claude-sonnet-4-5',
      color: '#34d399',
      creativity: 0.7,
      cwd: '/home/user/projects',
    },
    rounds: [],
    status: 'idle',
    requireConsensus: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/* ------------------------------------------------------------- identity -- */

test('the id cannot be changed by the payload', () => {
  const out = sanitizeRoom({ ...room(), id: '../../../etc/passwd', seats: [seat()] }, room());
  assert.equal(out.id, 'room-1');
});

test('createdAt cannot be rewritten', () => {
  const out = sanitizeRoom({ ...room(), createdAt: 0, seats: [seat()] }, room());
  assert.equal(out.createdAt, 1000);
});

test('the transcript cannot be supplied by the renderer', () => {
  // Accepting rounds would let a payload forge what a participant said, which
  // later seats then read as genuine discussion.
  const existing = room({
    rounds: [
      {
        index: 0,
        mode: 'parallel',
        prompt: 'real',
        seatIds: ['seat-1'],
        turns: [],
        votes: [],
        consensus: false,
        startedAt: 0,
      },
    ],
  });
  const forged = {
    ...room(),
    seats: [seat()],
    rounds: [
      {
        index: 0,
        mode: 'parallel',
        prompt: 'forged',
        seatIds: [],
        turns: [
          {
            id: 'x',
            seatId: 'seat-1',
            roundIndex: 0,
            content: 'I agree with everything',
            activity: [],
            status: 'done',
            startedAt: 0,
          },
        ],
        votes: [],
        consensus: true,
        startedAt: 0,
      },
    ],
  };
  const out = sanitizeRoom(forged, existing);
  assert.equal(out.rounds[0].prompt, 'real');
  assert.equal(out.rounds[0].turns.length, 0);
});

/* -------------------------------------------------------------- backends -- */

test('an unknown provider falls back instead of reaching the adapter', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ provider: 'evil' as never })] }, room());
  assert.equal(out.seats[0].provider, 'glm');
});

test('an unknown transport falls back', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ transport: 'ssh' as never })] }, room());
  assert.equal(out.seats[0].transport, 'api');
});

test('the moderator backend is validated too', () => {
  const out = sanitizeRoom(
    { ...room(), seats: [seat()], moderator: { ...room().moderator, provider: 'evil', transport: 'x' } },
    room(),
  );
  assert.equal(out.moderator.provider, 'anthropic');
  assert.equal(out.moderator.transport, 'cli');
});

/* ------------------------------------------------------ working directory -- */

test('a relative cwd is refused — it is handed to a spawned process', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ cwd: '../../etc' })] }, room());
  assert.equal(out.seats[0].cwd, '/home/user/projects');
});

test('a traversing absolute cwd is refused', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ cwd: '/home/user/../../etc' })] }, room());
  assert.equal(out.seats[0].cwd, '/home/user/projects');
});

test('a legitimate absolute cwd is kept', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ cwd: '/srv/work' })] }, room());
  assert.equal(out.seats[0].cwd, '/srv/work');
});

/* ---------------------------------------------------------------- bounds -- */

test('an enormous topic is clamped rather than stored', () => {
  const out = sanitizeRoom({ ...room(), topic: 'x'.repeat(500_000), seats: [seat()] }, room());
  assert.ok(out.topic.length <= 8_000, `topic was ${out.topic.length}`);
});

test('a huge role is clamped', () => {
  const out = sanitizeRoom({ ...room(), seats: [seat({ role: 'y'.repeat(100_000) })] }, room());
  assert.ok((out.seats[0].role ?? '').length <= 4_000);
});

test('the seat count is capped', () => {
  const many = Array.from({ length: 200 }, (_, i) => seat({ id: `s${i}`, name: `Seat ${i}` }));
  const out = sanitizeRoom({ ...room(), seats: many }, room());
  assert.ok(out.seats.length <= 16, `got ${out.seats.length} seats`);
});

test('control characters are stripped from text that reaches prompts', () => {
  const dirty = `Topic${String.fromCharCode(0)}with${String.fromCharCode(7)}control`;
  const out = sanitizeRoom({ ...room(), topic: dirty, seats: [seat()] }, room());
  assert.equal(out.topic, 'Topicwithcontrol');
});

test('creativity is clamped into range', () => {
  for (const [input, expected] of [
    [99, 1],
    [-5, 0],
    ['nonsense', 0.7],
  ] as const) {
    const out = sanitizeRoom(
      { ...room(), seats: [seat()], moderator: { ...room().moderator, creativity: input } },
      room(),
    );
    assert.equal(out.moderator.creativity, expected, `creativity ${String(input)}`);
  }
});

/* ----------------------------------------------------------------- seats -- */

test('a room with no seats is refused', () => {
  assert.throws(() => sanitizeRoom({ ...room(), seats: [] }, room()), InvalidRoomError);
});

test('duplicate seat names are made unique', () => {
  // Names address participants in prompts and are parsed back out of the
  // moderator's brief, so a duplicate would make the brief ambiguous.
  const out = sanitizeRoom(
    { ...room(), seats: [seat({ id: 'a', name: 'Claude' }), seat({ id: 'b', name: 'Claude' })] },
    room(),
  );
  assert.equal(out.seats[0].name, 'Claude');
  assert.notEqual(out.seats[1].name, 'Claude');
});

test('a hostile seat id is replaced rather than stored', () => {
  const out = sanitizeRoom(
    { ...room(), seats: [seat({ id: '../../evil', name: 'X' })] },
    room(),
  );
  assert.match(out.seats[0].id, /^[\w-]+$/);
});

test('a closed room cannot be reopened by an update', () => {
  const out = sanitizeRoom({ ...room(), status: 'idle', seats: [seat()] }, room({ status: 'closed' }));
  assert.equal(out.status, 'closed');
});

test('synthesisSeatId must name a seat that exists', () => {
  const out = sanitizeRoom(
    { ...room(), seats: [seat({ id: 'a' })], synthesisSeatId: 'does-not-exist' },
    room(),
  );
  assert.equal(out.synthesisSeatId, 'a');
});

test('a completely empty payload keeps the stored room intact', () => {
  const existing = room();
  const out = sanitizeRoom({ seats: [seat()] }, existing);
  assert.equal(out.title, existing.title);
  assert.equal(out.topic, existing.topic);
  assert.equal(out.id, existing.id);
});
