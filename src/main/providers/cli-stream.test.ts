import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeParser, createCodexParser } from './cli-stream';

/**
 * The failure these tests exist for is silent: the CLI runs, exits zero, and
 * the user sees an empty reply. It happens whenever the parser's assumption
 * about which envelope carries the text is wrong for the build in front of it.
 */

function run(parser: ReturnType<typeof createClaudeParser>, events: unknown[]) {
  const out = events.flatMap((e) => parser(e));
  return [...out, ...parser.finish()];
}

const textOf = (emits: any[]) =>
  emits.filter((e) => e.type === 'text').map((e) => e.text).join('');

/* --------------------------------------------------------------- claude -- */

test('a streaming build emits the reply once, from the deltas', () => {
  const emits = run(createClaudeParser('s'), [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
    // Claude Code sends the finished message too. Counting it again would
    // print the whole reply twice.
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    { type: 'result', session_id: 'abc', result: 'Hello world', usage: { input_tokens: 5, output_tokens: 2 } },
  ]);
  assert.equal(textOf(emits), 'Hello world');
});

test('a build without --include-partial-messages still produces the reply', () => {
  // The regression this file was written for: no deltas, so the whole
  // assistant message is the only place the answer exists.
  const emits = run(createClaudeParser('s'), [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    { type: 'result', session_id: 'abc' },
  ]);
  assert.equal(textOf(emits), 'Hello world');
});

test('a build that reports only the final result still produces the reply', () => {
  const emits = run(createClaudeParser('s'), [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'result', session_id: 'abc', result: 'Hello world' },
  ]);
  assert.equal(textOf(emits), 'Hello world');
});

test('tool calls are reported even while deltas carry the text', () => {
  const emits = run(createClaudeParser('s'), [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'WebSearch', input: { query: 'glm 4.6 context window' } },
          { type: 'text', text: 'ok' },
        ],
      },
    },
  ]);
  const tool = emits.find((e: any) => e.type === 'tool') as any;
  assert.equal(tool.name, 'WebSearch');
  assert.equal(tool.query, 'glm 4.6 context window');
  assert.equal(textOf(emits), 'ok', 'the text must not be counted twice');
});

test('thinking is separated from the reply', () => {
  const emits = run(createClaudeParser('s'), [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } } },
  ]);
  assert.equal(textOf(emits), 'answer');
  assert.equal((emits.find((e: any) => e.type === 'reasoning') as any).text, 'hmm');
});

test('an error result surfaces as an error, not as the reply', () => {
  const emits = run(createClaudeParser('s'), [
    { type: 'result', is_error: true, result: 'Credit balance is too low' },
  ]);
  assert.equal(textOf(emits), '');
  assert.match((emits.find((e: any) => e.type === 'error') as any).message, /Credit balance/);
});

test('lines the CLI adds in a future release are ignored, not fatal', () => {
  const emits = run(createClaudeParser('s'), [
    null,
    'a bare string',
    { type: 'something_new', payload: {} },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'fine' }] } },
  ]);
  assert.equal(textOf(emits), 'fine');
});

/* ---------------------------------------------------------------- codex -- */

test('codex 0.x deltas produce the reply once', () => {
  const emits = run(createCodexParser('s'), [
    { msg: { type: 'agent_message_delta', delta: 'Hel' } },
    { msg: { type: 'agent_message_delta', delta: 'lo' } },
    { msg: { type: 'agent_message', message: 'Hello' } },
  ]);
  assert.equal(textOf(emits), 'Hello');
});

test('a codex build that only sends whole messages still produces the reply', () => {
  const emits = run(createCodexParser('s'), [{ msg: { type: 'agent_message', message: 'Hello' } }]);
  assert.equal(textOf(emits), 'Hello');
});

test('the newer codex item envelope is not counted on top of deltas', () => {
  const emits = run(createCodexParser('s'), [
    { type: 'thread.started', thread_id: 't1' },
    { msg: { type: 'agent_message_delta', delta: 'Hello' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } },
  ]);
  assert.equal(textOf(emits), 'Hello');
  assert.equal((emits.find((e: any) => e.type === 'session') as any).sessionId, 't1');
});

test('codex shell and search calls become trail entries', () => {
  const emits = run(createCodexParser('s'), [
    { msg: { type: 'exec_command_begin', command: ['rg', '-n', 'foo'] } },
    { msg: { type: 'web_search_begin', query: 'zhipu glm pricing' } },
  ]);
  const tools = emits.filter((e: any) => e.type === 'tool') as any[];
  assert.equal(tools[0].detail, 'rg -n foo');
  assert.equal(tools[1].query, 'zhipu glm pricing');
});
