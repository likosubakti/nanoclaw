import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esc, splitMessage } from './api';

/**
 * Telegram rejects a message over 4096 characters outright, and rejects the
 * whole message if its HTML does not parse. Both failures lose a turn of a
 * discussion the user is watching from their phone, so both are pinned here.
 */

test('short messages pass through as a single part', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('long messages are split under the limit', () => {
  const parts = splitMessage('x'.repeat(10_000));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 3900, `part too long: ${part.length}`);
});

test('splitting prefers paragraph breaks so prose is not cut mid-sentence', () => {
  const paragraph = 'a'.repeat(2000);
  const parts = splitMessage(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);
  assert.ok(parts.length >= 2);
  // No part should start mid-paragraph, i.e. with the filler character run
  // immediately following a cut that ignored the blank line.
  assert.ok(parts.every((p) => !p.startsWith('\n')));
});

test('splitting never loses content', () => {
  const source = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const parts = splitMessage(source, 500);
  const rejoined = parts.join('\n');
  for (let i = 0; i < 400; i++) {
    assert.ok(rejoined.includes(`line ${i}`), `lost line ${i}`);
  }
});

test('a single unbreakable run is still split rather than rejected', () => {
  const parts = splitMessage('y'.repeat(9000), 1000);
  assert.ok(parts.length >= 9);
  for (const part of parts) assert.ok(part.length <= 1000);
});

test('esc neutralises the characters Telegram parses as markup', () => {
  assert.equal(esc('<b>hi</b> & "there"'), '&lt;b&gt;hi&lt;/b&gt; &amp; "there"');
});

test('esc keeps model output from breaking the message', () => {
  // A seat quoting HTML would otherwise make Telegram reject the whole post.
  const seatOutput = 'Use <script>alert(1)</script> — see a < b && c > d';
  const escaped = esc(seatOutput);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(!/<[a-z]/i.test(escaped), 'no tag may survive escaping');
});
