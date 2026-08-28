import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PAIR_ATTEMPTS, PAIRING_TTL_MS, PairingCode } from './pairing';

/**
 * Six digits is 900,000 possibilities and the bot answers every guess, so the
 * code is its own oracle. Everything below is what makes that safe; if any of
 * it stops holding, the code is a static shared secret guarding every
 * discussion in the app and unmetered spending on the owner's plans.
 */

function at(clock: { now: number }) {
  return new PairingCode(() => clock.now);
}

test('a code works exactly once', () => {
  const clock = { now: 0 };
  const p = at(clock);
  const code = p.issue();
  assert.equal(p.check(code), true);
  assert.equal(p.check(code), false, 'the same code must not pair a second chat');
  assert.equal(p.live(), '', 'and it must disappear from the Settings screen');
});

test('a code expires even if it is never used', () => {
  const clock = { now: 0 };
  const p = at(clock);
  const code = p.issue();
  clock.now += PAIRING_TTL_MS - 1;
  assert.equal(p.live(), code);
  clock.now += 2;
  assert.equal(p.live(), '', 'an old screenshot must not pair a chat later');
  assert.equal(p.check(code), false);
});

test('wrong guesses burn the code, not the attacker’s patience', () => {
  const clock = { now: 0 };
  const p = at(clock);
  const code = p.issue();
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 1; i < MAX_PAIR_ATTEMPTS; i++) {
    assert.equal(p.check(wrong), false);
    assert.equal(p.live(), code, `still live after ${i} wrong guesses`);
  }
  assert.equal(p.check(wrong), false);
  assert.equal(p.live(), '', 'revoked on the last allowed attempt');
  assert.equal(p.check(code), false, 'even the right code no longer works');
});

test('issuing a new code invalidates the previous one', () => {
  const clock = { now: 0 };
  const p = at(clock);
  const first = p.issue();
  const second = p.issue();
  assert.notEqual(first, second);
  assert.equal(p.check(first), false);
  assert.equal(p.check(second), true);
});

test('a fresh code resets the attempt counter', () => {
  const clock = { now: 0 };
  const p = at(clock);
  p.issue();
  for (let i = 0; i < MAX_PAIR_ATTEMPTS - 1; i++) p.check('000000');
  const next = p.issue();
  p.check('000000');
  assert.equal(p.live(), next, 'the previous run of failures must not count');
});

test('revoking leaves nothing to guess', () => {
  const clock = { now: 0 };
  const p = at(clock);
  const code = p.issue();
  p.revoke();
  assert.equal(p.live(), '');
  assert.equal(p.check(code), false);
});

test('no code is live before one is issued', () => {
  const p = at({ now: 0 });
  assert.equal(p.live(), '');
  assert.equal(p.check('123456'), false);
});

test('the code is six digits', () => {
  const p = at({ now: 0 });
  for (let i = 0; i < 50; i++) assert.match(p.issue(), /^\d{6}$/);
});
