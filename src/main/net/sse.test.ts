import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonLines, readSse } from './sse';

/** Builds a ReadableStream that emits the given byte chunks in order. */
function streamOf(chunks: Array<Uint8Array | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const message of readSse(stream)) out.push(message);
  return out;
}

test('parses simple data events', async () => {
  const events = await collect(streamOf(['data: one\n\ndata: two\n\n']));
  assert.deepEqual(
    events.map((e) => e.data),
    ['one', 'two'],
  );
});

test('event boundaries may fall anywhere across chunks', async () => {
  // The classic failure: a chunk ends mid-event, or mid-boundary.
  const events = await collect(streamOf(['data: hel', 'lo\n', '\ndata: wor', 'ld\n\n']));
  assert.deepEqual(
    events.map((e) => e.data),
    ['hello', 'world'],
  );
});

test('multi-byte UTF-8 split across chunks is not corrupted', async () => {
  // "汉" is E6 B1 89; splitting it must not produce U+FFFD.
  const bytes = new TextEncoder().encode('data: 汉字\n\n');
  const events = await collect(streamOf([bytes.slice(0, 8), bytes.slice(8)]));
  assert.equal(events[0].data, '汉字');
});

test('handles CRLF framing', async () => {
  const events = await collect(streamOf(['data: a\r\n\r\ndata: b\r\n\r\n']));
  assert.deepEqual(
    events.map((e) => e.data),
    ['a', 'b'],
  );
});

test('reads named events and multi-line data', async () => {
  const events = await collect(
    streamOf(['event: content_block_delta\ndata: {"a":1}\ndata: {"b":2}\n\n']),
  );
  assert.equal(events[0].event, 'content_block_delta');
  assert.equal(events[0].data, '{"a":1}\n{"b":2}');
});

test('ignores comments and heartbeats', async () => {
  const events = await collect(streamOf([': ping\n\ndata: real\n\n']));
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'real');
});

test('flushes a trailing event with no terminating blank line', async () => {
  const events = await collect(streamOf(['data: [DONE]']));
  assert.equal(events[0].data, '[DONE]');
});

test('strips exactly one leading space after the colon', async () => {
  const events = await collect(streamOf(['data:  two-spaces\n\n']));
  assert.equal(events[0].data, ' two-spaces');
});

/* ---------------------------------------------------------- JSON lines --- */

async function* asyncChunks(chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

test('reads newline-delimited JSON across chunk boundaries', async () => {
  const out = [];
  for await (const value of readJsonLines(asyncChunks(['{"a":1}\n{"b', '":2}\n']))) {
    out.push(value);
  }
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('skips non-JSON chatter between JSON lines', async () => {
  const out = [];
  const chunks = ['warning: something\n{"ok":true}\n'];
  for await (const value of readJsonLines(asyncChunks(chunks))) out.push(value);
  assert.deepEqual(out, [{ ok: true }]);
});

test('emits a trailing JSON line with no final newline', async () => {
  const out = [];
  for await (const value of readJsonLines(asyncChunks(['{"last":true}']))) out.push(value);
  assert.deepEqual(out, [{ last: true }]);
});
