import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Room, Seat } from '@shared/roundtable';
import { instructionForSeat, parseBrief, parseVerdict, renderTranscript } from './prompts';

/**
 * The moderator writes free text, so these parsers stand between a model's
 * formatting whims and the discussion continuing. Every failure mode here has
 * to degrade rather than throw: a brief that will not parse must still produce
 * a usable instruction, and a verdict that will not parse must never be read as
 * "conclude".
 */

function seat(id: string, name: string, role?: string): Seat {
  return {
    id,
    name,
    provider: 'glm',
    transport: 'api',
    model: 'glm-4.6',
    enabled: true,
    color: '#000',
    role,
  };
}

function room(seats: Seat[]): Room {
  return {
    id: 'r1',
    title: 'T',
    topic: 'Should we migrate to SQLite?',
    seats,
    moderator: {
      enabled: true,
      name: 'Moderator',
      provider: 'anthropic',
      transport: 'cli',
      model: 'claude-sonnet-4-5',
      color: '#0f0',
      creativity: 0.7,
    },
    rounds: [],
    status: 'idle',
    requireConsensus: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ROOM = room([seat('a', 'GLM', 'Mathematician'), seat('b', 'Codex', 'CTO'), seat('c', 'Claude')]);

/* ----------------------------------------------------------------- brief -- */

test('parses a well-formed brief', () => {
  const brief = parseBrief(
    ROOM,
    [
      'AGENDA:',
      'Decide whether the write throughput justifies staying on Postgres.',
      '',
      'FOR GLM:',
      'Model the write volume and give the crossover point.',
      '',
      'FOR Codex:',
      'Assess the operational cost of each option.',
      '',
      'FOR Claude:',
      'Argue the migration risk.',
      '',
      'NOTES:',
      'SQLite added WAL2 in 3.46.',
    ].join('\n'),
  );

  assert.match(brief.agenda, /write throughput/);
  assert.equal(brief.perSeat.a, 'Model the write volume and give the crossover point.');
  assert.equal(brief.perSeat.b, 'Assess the operational cost of each option.');
  assert.equal(brief.perSeat.c, 'Argue the migration risk.');
  assert.equal(brief.notes, 'SQLite added WAL2 in 3.46.');
});

test('treats "none" notes as absent', () => {
  const brief = parseBrief(ROOM, 'AGENDA:\nDo the thing.\n\nNOTES:\nnone');
  assert.equal(brief.notes, undefined);
});

test('a brief with no per-seat sections still yields an agenda', () => {
  const brief = parseBrief(ROOM, 'AGENDA:\nJust decide already.');
  assert.equal(brief.agenda, 'Just decide already.');
  assert.deepEqual(brief.perSeat, {});
});

test('a brief that ignores the format entirely becomes the agenda', () => {
  const raw = 'I think the room should focus on write throughput and nothing else.';
  const brief = parseBrief(ROOM, raw);
  assert.equal(brief.agenda, raw);
  assert.deepEqual(brief.perSeat, {});
});

test('seat names containing regex metacharacters do not break matching', () => {
  const tricky = room([seat('x', 'GPT-5.1 (o-series)'), seat('y', 'C++ dev')]);
  const brief = parseBrief(
    tricky,
    'AGENDA:\nA\n\nFOR GPT-5.1 (o-series):\nDo X.\n\nFOR C++ dev:\nDo Y.',
  );
  assert.equal(brief.perSeat.x, 'Do X.');
  assert.equal(brief.perSeat.y, 'Do Y.');
});

test('matches seat headings case-insensitively', () => {
  const brief = parseBrief(ROOM, 'agenda:\nA\n\nfor glm:\nDo X.');
  assert.equal(brief.perSeat.a, 'Do X.');
});

test('a missing seat simply gets no tailored instruction', () => {
  const brief = parseBrief(ROOM, 'AGENDA:\nA\n\nFOR GLM:\nDo X.');
  assert.equal(brief.perSeat.a, 'Do X.');
  assert.equal(brief.perSeat.b, undefined);
});

/* --------------------------------------------------------------- verdict -- */

test('parses a conclude verdict', () => {
  const v = parseVerdict('VERDICT: CONCLUDE\n\nREASON:\nBoth sides now agree.\n\nFOCUS:\nnone');
  assert.equal(v.conclude, true);
  assert.equal(v.reason, 'Both sides now agree.');
  assert.equal(v.focus, undefined);
});

test('parses a continue verdict with a focus', () => {
  const v = parseVerdict(
    'VERDICT: CONTINUE\n\nREASON:\nThe cost model is unresolved.\n\nFOCUS:\nSettle the write volume estimate.',
  );
  assert.equal(v.conclude, false);
  assert.equal(v.focus, 'Settle the write volume estimate.');
});

test('an unparseable verdict never concludes', () => {
  // The dangerous failure would be reading noise as "we are done".
  for (const raw of ['', 'I am not sure yet.', 'The room seems close to agreement.', '{}']) {
    const v = parseVerdict(raw);
    assert.equal(v.conclude, false, `should not conclude on: ${JSON.stringify(raw)}`);
  }
});

test('the word "conclude" in prose does not trigger a conclusion', () => {
  const v = parseVerdict('I would not conclude yet.\nThe room is still split.');
  assert.equal(v.conclude, false);
});

test('verdict parsing is case-insensitive', () => {
  assert.equal(parseVerdict('verdict: conclude\nreason: done').conclude, true);
});

/* --------------------------------------------------------- instructions --- */

test('without a brief, the seat gets the plain mode instruction', () => {
  const text = instructionForSeat('parallel', { prompt: 'What should we do?' }, ROOM.seats[0]);
  assert.match(text, /What should we do\?/);
  assert.match(text, /cannot see them yet/);
});

test('with a brief, the seat gets the agenda plus its own tailored instruction', () => {
  const text = instructionForSeat(
    'parallel',
    {
      prompt: 'raw',
      brief: { agenda: 'The agenda.', perSeat: { a: 'Your specific job.' }, notes: 'A fact.' },
    },
    ROOM.seats[0],
  );
  assert.match(text, /The agenda\./);
  assert.match(text, /A fact\./);
  assert.match(text, /Your specific job\./);
  assert.match(text, /Mathematician/, 'the role should be named in the brief');
});

test('a seat the brief skipped still gets the agenda and the mode reminder', () => {
  const text = instructionForSeat(
    'critique',
    { prompt: 'raw', brief: { agenda: 'The agenda.', perSeat: {} } },
    ROOM.seats[1],
  );
  assert.match(text, /The agenda\./);
  assert.match(text, /Cross-examine/);
});

/* ------------------------------------------------------------ transcript -- */

test('the transcript labels speakers and excludes the in-flight turn', () => {
  const r = room([seat('a', 'GLM'), seat('b', 'Codex')]);
  r.rounds = [
    {
      index: 0,
      mode: 'parallel',
      prompt: 'Kick off',
      seatIds: ['a', 'b'],
      votes: [],
      consensus: false,
      startedAt: 0,
      turns: [
        { id: 't1', seatId: 'a', roundIndex: 0, content: 'GLM says this.', activity: [], status: 'done', startedAt: 0 },
        { id: 't2', seatId: 'b', roundIndex: 0, content: 'Codex says that.', activity: [], status: 'done', startedAt: 0 },
      ],
    },
  ];

  const full = renderTranscript(r, 0);
  assert.match(full, /\*\*GLM:\*\*/);
  assert.match(full, /\*\*Codex:\*\*/);

  const excluding = renderTranscript(r, 0, 't2');
  assert.match(excluding, /GLM says this\./);
  assert.ok(!excluding.includes('Codex says that.'), 'the seat’s own in-flight turn is excluded');
});

test('failed turns never enter the transcript', () => {
  const r = room([seat('a', 'GLM')]);
  r.rounds = [
    {
      index: 0,
      mode: 'parallel',
      prompt: 'Kick off',
      seatIds: ['a'],
      votes: [],
      consensus: false,
      startedAt: 0,
      turns: [
        { id: 't1', seatId: 'a', roundIndex: 0, content: '', activity: [], status: 'error', error: 'boom', startedAt: 0 },
      ],
    },
  ];
  const text = renderTranscript(r, 0);
  assert.ok(!text.includes('boom'), 'an error must not be presented to the room as a contribution');
});
