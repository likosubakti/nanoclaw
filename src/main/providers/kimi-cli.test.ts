import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest } from '@shared/types';
import { KIMI_RESEARCH_TOOLS, kimiAgentSpec, kimiArgs } from './cli-args';
import { createKimiParser } from './cli-stream';

/**
 * Kimi Code restricts its toolset through an agent specification rather than a
 * flag, and streams whole messages rather than token deltas. Both differ from
 * the other two CLIs in ways that fail quietly if they regress: a spec that
 * names the wrong tools hands a discussant the filesystem, and a parser that
 * expects deltas returns an empty answer.
 */

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    conversationId: 'c',
    provider: 'kimi',
    model: 'kimi-k2.6',
    transport: 'cli',
    messages: [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }],
    ...over,
  };
}

const valuesAfter = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? [] : [args[at + 1]];
};

/* ------------------------------------------------------------------ argv -- */

test('a turn runs in print mode with a JSON stream', () => {
  const args = kimiArgs(req());
  assert.ok(args.includes('--print'));
  assert.deepEqual(valuesAfter(args, '--output-format'), ['stream-json']);
  assert.deepEqual(valuesAfter(args, '--model'), ['kimi-k2.6']);
});

test('thinking is stated explicitly in both directions', () => {
  // Kimi treats an absent flag as "whatever the user's config says", so
  // leaving it out would let a config file decide, not the app.
  assert.ok(kimiArgs(req({ thinking: true })).includes('--thinking'));
  assert.ok(kimiArgs(req({ thinking: false })).includes('--no-thinking'));
});

test('an agent file is passed through only when one was generated', () => {
  assert.ok(!kimiArgs(req()).includes('--agent-file'));
  const args = kimiArgs(req(), { agentFile: '/tmp/x/agent.yaml' });
  assert.deepEqual(valuesAfter(args, '--agent-file'), ['/tmp/x/agent.yaml']);
});

/* ------------------------------------------------------------ agent spec -- */

test('a chat turn names no tools at all', () => {
  // `tools` is an allowlist of fully-qualified classes, so an empty list is
  // genuinely no tools — the equivalent of Claude Code's `--tools ""`.
  const spec = kimiAgentSpec('/tmp/x/system.md', 'none');
  assert.match(spec, /tools: \[\]/);
  assert.match(spec, /system_prompt_path: "\/tmp\/x\/system\.md"/);
  assert.ok(!spec.includes('Shell'), 'a discussant must not be able to run commands');
  assert.ok(!spec.includes('WriteFile'));
});

test('a research turn names exactly search and fetch', () => {
  const spec = kimiAgentSpec('/tmp/x/system.md', 'research');
  for (const tool of KIMI_RESEARCH_TOOLS) assert.ok(spec.includes(tool), tool);
  assert.ok(!spec.includes('Shell'));
  assert.ok(!spec.includes('WriteFile'));
  assert.ok(!spec.includes('ReadFile'), 'reading the user’s files is not research');
});

test('the spec quotes a path containing spaces', () => {
  const spec = kimiAgentSpec('/home/a b/system.md', 'none');
  assert.match(spec, /system_prompt_path: "\/home\/a b\/system\.md"/);
});

test('the spec drops the builtin subagents', () => {
  // Left inherited, a subagent would run with its own unrestricted toolset.
  assert.match(kimiAgentSpec('/tmp/s.md', 'none'), /subagents: \{\}/);
});

/* --------------------------------------------------------------- parser -- */

const textOf = (emits: any[]) =>
  emits.filter((e) => e.type === 'text').map((e) => e.text).join('');

function run(events: unknown[]) {
  const parse = createKimiParser('s');
  return [...events.flatMap((e) => parse(e)), ...parse.finish()];
}

test('a whole assistant message carries the reply', () => {
  const emits = run([
    { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
  ]);
  assert.equal(textOf(emits), 'Hello world');
});

test('successive messages append rather than replace', () => {
  // Kimi flushes a message per step, so every line is new content — unlike the
  // other two, where the whole message repeats what the deltas already sent.
  const emits = run([
    { role: 'assistant', content: [{ type: 'text', text: 'One. ' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two.' }] },
  ]);
  assert.equal(textOf(emits), 'One. Two.');
});

test('thinking is separated from the reply', () => {
  const emits = run([
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'weighing it up' },
        { type: 'text', text: 'the answer' },
      ],
    },
  ]);
  assert.equal(textOf(emits), 'the answer');
  assert.equal((emits.find((e: any) => e.type === 'reasoning') as any).text, 'weighing it up');
});

test('a web search becomes a readable trail entry', () => {
  const emits = run([
    {
      role: 'assistant',
      content: [],
      tool_calls: [
        {
          type: 'function',
          id: '1',
          function: { name: 'SearchWeb', arguments: '{"query":"kimi k2 context window"}' },
        },
      ],
    },
  ]);
  const tool = emits.find((e: any) => e.type === 'tool') as any;
  // Normalised to the same name the other providers emit, so one trail
  // renderer serves every seat.
  assert.equal(tool.name, 'WebSearch');
  assert.equal(tool.query, 'kimi k2 context window');
});

test('a fetch carries its URL, so the trail can link it', () => {
  const emits = run([
    {
      role: 'assistant',
      content: [],
      tool_calls: [
        { type: 'function', id: '1', function: { name: 'FetchURL', arguments: '{"url":"https://a.example"}' } },
      ],
    },
  ]);
  const tool = emits.find((e: any) => e.type === 'tool') as any;
  assert.equal(tool.name, 'WebFetch');
  assert.equal(tool.url, 'https://a.example');
});

test('unparseable tool arguments do not lose the tool call', () => {
  const emits = run([
    {
      role: 'assistant',
      content: [],
      tool_calls: [{ type: 'function', id: '1', function: { name: 'Shell', arguments: '{broken' } }],
    },
  ]);
  assert.equal((emits.find((e: any) => e.type === 'tool') as any).name, 'shell');
});

test('tool results and plan lines are not mistaken for the reply', () => {
  const emits = run([
    { role: 'tool', tool_call_id: '1', content: [{ type: 'text', text: 'command output' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
  ]);
  assert.equal(textOf(emits), 'the answer');
});

test('lines a future release adds are ignored, not fatal', () => {
  const emits = run([
    null,
    'a bare string',
    { role: 'assistant', content: [{ type: 'something_new' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'fine' }] },
  ]);
  assert.equal(textOf(emits), 'fine');
});
