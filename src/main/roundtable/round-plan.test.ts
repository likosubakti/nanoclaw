import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Room, Seat } from '@shared/roundtable';
import { foldRound, pickParticipants } from './round-plan';

function seat(over: Partial<Seat> = {}): Seat {
  return {
    id: 's1',
    name: 'GLM',
    provider: 'glm',
    transport: 'api',
    model: 'glm-4.6',
    enabled: true,
    color: '#38bdf8',
    ...over,
  };
}

function room(over: Partial<Room> = {}): Room {
  return {
    id: 'r',
    title: 'T',
    topic: 'Topic',
    seats: [seat({ id: 'a', name: 'A' }), seat({ id: 'b', name: 'B' })],
    moderator: {
      enabled: true,
      name: 'Moderator',
      provider: 'anthropic',
      transport: 'cli',
      model: 'claude-opus-5',
      color: '#34d399',
      creativity: 0.7,
    },
    rounds: [],
    status: 'idle',
    requireConsensus: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/* -------------------------------------------------------- participants -- */

test('a normal round seats every enabled seat', () => {
  const r = room({ seats: [seat({ id: 'a' }), seat({ id: 'b', enabled: false })] });
  assert.deepEqual(pickParticipants(r, 'parallel', undefined).map((s) => s.id), ['a']);
});

test('wrap up still works when the pinned seat is disabled', () => {
  // The pin is set once at creation and nothing repairs it, so disabling that
  // one seat used to make every future wrap-up fail with "No seats are enabled
  // for this round" — while the rest of the room sat there enabled, and with
  // nothing in the UI naming the seat that was actually the problem.
  const r = room({
    seats: [seat({ id: 'a', enabled: false }), seat({ id: 'b' })],
    synthesisSeatId: 'a',
  });
  assert.deepEqual(pickParticipants(r, 'synthesis', undefined).map((s) => s.id), ['b']);
});

test('the pinned seat writes the conclusion when it is available', () => {
  const r = room({ synthesisSeatId: 'b' });
  assert.deepEqual(pickParticipants(r, 'synthesis', undefined).map((s) => s.id), ['b']);
});

test('a synthesis round is always exactly one seat', () => {
  assert.equal(pickParticipants(room(), 'synthesis', undefined).length, 1);
});

test('a pin outside the requested subset does not empty the round', () => {
  const r = room({ synthesisSeatId: 'a' });
  assert.deepEqual(pickParticipants(r, 'synthesis', ['b']).map((s) => s.id), ['b']);
});

test('a room with nothing enabled still reports no participants', () => {
  const r = room({ seats: [seat({ id: 'a', enabled: false })] });
  assert.equal(pickParticipants(r, 'synthesis', undefined).length, 0);
});

/* ---------------------------------------------------------------- fold -- */

test('closing a room mid-round survives the round finishing', () => {
  // The round holds the Room it read at the start. Writing that copy back
  // whole erased the close — and `closed` is the only thing stopping a paired
  // phone from restarting a discussion the owner ended.
  const stored = room({ status: 'closed' });
  const inRound = room({ status: 'idle', rounds: [] });
  assert.equal(foldRound(stored, inRound).status, 'closed');
});

test('seat edits made during a round are not reverted by its final save', () => {
  const stored = room({ seats: [seat({ id: 'a', name: 'Renamed', role: 'CTO' })] });
  const inRound = room({ seats: [seat({ id: 'a', name: 'A' })] });
  const out = foldRound(stored, inRound);
  assert.equal(out.seats[0].name, 'Renamed');
  assert.equal(out.seats[0].role, 'CTO');
});

test('the transcript comes from the round, never from disk', () => {
  const stored = room({ rounds: [] });
  const inRound = room({
    rounds: [
      { index: 0, mode: 'parallel', prompt: 'p', seatIds: ['a'], turns: [], votes: [], consensus: false, startedAt: 0 },
    ],
  });
  assert.equal(foldRound(stored, inRound).rounds.length, 1);
});

test('a round that reached a conclusion keeps it; one that did not keeps the stored one', () => {
  assert.equal(foldRound(room({ conclusion: 'old' }), room({ conclusion: 'new' })).conclusion, 'new');
  assert.equal(foldRound(room({ conclusion: 'old' }), room()).conclusion, 'old');
});

test('an ordinary round still reports its own status', () => {
  assert.equal(foldRound(room({ status: 'idle' }), room({ status: 'running' })).status, 'running');
});
