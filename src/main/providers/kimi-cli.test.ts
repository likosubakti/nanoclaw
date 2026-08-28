import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest } from '@shared/types';
import { KIMI_RESEARCH_TOOLS, kimiAgentProfile, kimiArgs } from './cli-args';
import { createKimiParser } from './cli-stream';

/**
 * Kimi Code differs from the other two CLIs in three ways that each fail
 * quietly if they regress: it restricts tools through an agent profile rather
 * than a flag, its `--model` names a config alias rather than an API model id,
 * and its stream is role-tagged messages rather than token deltas.
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

test('a turn asks for the JSON stream and carries the prompt', () => {
  const args = kimiArgs(req());
  assert.deepEqual(valuesAfter(args, '--output-format'), ['stream-json']);
  assert.deepEqual(valuesAfter(args, '--prompt'), ['hi']);
});

test('the seat model is deliberately not sent', () => {
  // `--model` names an alias in the user's config.toml, not an API model id.
  // Passing a catalog id is not a soft failure — the CLI refuses the turn with
  // `Model "kimi-k2.6" is not configured in config.toml.`
  const args = kimiArgs(req({ model: 'kimi-k2.6' }));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('-m'));
  assert.ok(!args.includes('kimi-k2.6'));
});

test('the prompt goes last, so one starting with a dash is unambiguous', () => {
  const args = kimiArgs(req({ messages: [{ id: 'u', role: 'user', content: '--help me', createdAt: 0 }] }));
  assert.equal(args[args.length - 2], '--prompt');
  assert.equal(args[args.length - 1], '--help me');
});

test('the last user message is the prompt, not the first', () => {
  const args = kimiArgs(
    req({
      messages: [
        { id: 'a', role: 'user', content: 'older', createdAt: 0 },
        { id: 'b', role: 'assistant', content: 'reply', createdAt: 1 },
        { id: 'c', role: 'user', content: 'newest', createdAt: 2 },
      ],
    }),
  );
  assert.deepEqual(valuesAfter(args, '--prompt'), ['newest']);
});

test('an agent file is passed through only when one was generated', () => {
  assert.ok(!kimiArgs(req()).includes('--agent-file'));
  const args = kimiArgs(req(), { agentFile: '/tmp/x/discussant.md' });
  assert.deepEqual(valuesAfter(args, '--agent-file'), ['/tmp/x/discussant.md']);
});

/* --------------------------------------------------------- agent profile -- */

test('a chat turn names no tools at all', () => {
  // `tools` is an allowlist, so an empty list is genuinely no tools — the
  // equivalent of Claude Code's `--tools ""`.
  const profile = kimiAgentProfile('You are taking part in a conversation.', 'none');
  assert.match(profile, /^---\n/, 'a Kimi profile is Markdown with YAML frontmatter');
  assert.match(profile, /tools: \[\]/);
  assert.match(profile, /subagents: \[\]/, 'an inherited subagent would run unrestricted');
  assert.ok(profile.includes('You are taking part in a conversation.'), 'the body is the prompt');
  assert.ok(!profile.includes('Bash'));
});

test('a research turn names exactly search and fetch', () => {
  const profile = kimiAgentProfile('sys', 'research');
  for (const tool of KIMI_RESEARCH_TOOLS) assert.ok(profile.includes(tool), tool);
  assert.ok(!profile.includes('Bash'));
  assert.ok(!profile.includes('Write'));
  assert.ok(!profile.includes('Read"'), 'reading the user’s files is not research');
});

test('the profile name matches the pattern Kimi enforces', () => {
  // Kimi rejects a profile whose name is not ^[a-z0-9]+(?:-[a-z0-9]+)*$.
  const name = /^name: (.+)$/m.exec(kimiAgentProfile('sys', 'none'))?.[1];
  assert.match(String(name), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('the frontmatter fence closes before the prompt body', () => {
  const profile = kimiAgentProfile('BODY TEXT', 'none');
  const fences = profile.split('\n').filter((l) => l.trim() === '---').length;
  assert.equal(fences, 2);
  assert.ok(profile.indexOf('BODY TEXT') > profile.lastIndexOf('---'));
});

/* --------------------------------------------------------------- parser -- */

const textOf = (emits: any[]) =>
  emits.filter((e) => e.type === 'text').map((e) => e.text).join('');

function run(events: unknown[]) {
  const parse = createKimiParser('s');
  return [...events.flatMap((e) => parse(e)), ...parse.finish()];
}

test('the real wire shape carries the reply', () => {
  // Verbatim from `kimi -p … --output-format stream-json`: content is a plain
  // string, not an array of parts.
  const emits = run([
    { role: 'meta', type: 'system.version', version: '0.39.0' },
    { role: 'assistant', content: 'Hello world' },
  ]);
  assert.equal(textOf(emits), 'Hello world');
});

test('successive assistant lines append rather than replace', () => {
  // The writer flushes one line per assistant message, so every line is new.
  const emits = run([
    { role: 'assistant', content: 'One. ' },
    { role: 'assistant', content: 'Two.' },
  ]);
  assert.equal(textOf(emits), 'One. Two.');
});

test('the resume hint becomes the session id', () => {
  const emits = run([
    { role: 'meta', type: 'session.resume_hint', session_id: 'abc', command: 'kimi -r abc' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal((emits.find((e: any) => e.type === 'session') as any).sessionId, 'abc');
});

test('meta lines are never mistaken for the reply', () => {
  const emits = run([
    { role: 'meta', type: 'system.version', version: '0.39.0' },
    { role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, next_attempt: 2 },
  ]);
  assert.equal(textOf(emits), '');
});

test('tool results are not the reply', () => {
  const emits = run([
    { role: 'tool', tool_call_id: '1', content: 'command output' },
    { role: 'assistant', content: 'the answer' },
  ]);
  assert.equal(textOf(emits), 'the answer');
});

test('a web search becomes a readable trail entry', () => {
  const emits = run([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { type: 'function', id: '1', function: { name: 'WebSearch', arguments: '{"query":"kimi k2 context"}' } },
      ],
    },
  ]);
  const tool = emits.find((e: any) => e.type === 'tool') as any;
  assert.equal(tool.name, 'WebSearch');
  assert.equal(tool.query, 'kimi k2 context');
});

test('a fetch carries its URL, so the trail can link it', () => {
  const emits = run([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { type: 'function', id: '1', function: { name: 'WebFetch', arguments: '{"url":"https://a.example"}' } },
      ],
    },
  ]);
  const tool = emits.find((e: any) => e.type === 'tool') as any;
  assert.equal(tool.url, 'https://a.example');
});

test('unparseable tool arguments do not lose the tool call', () => {
  const emits = run([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ type: 'function', id: '1', function: { name: 'Bash', arguments: '{broken' } }],
    },
  ]);
  assert.equal((emits.find((e: any) => e.type === 'tool') as any).name, 'shell');
});

test('the legacy kimi-cli shape still produces a reply', () => {
  // A user with the wound-down Python CLI still on PATH should get a working
  // seat rather than a silently empty one.
  const emits = run([
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'weighing it up' },
        { type: 'text', text: 'the answer' },
      ],
      tool_calls: [
        { type: 'function', id: '1', function: { name: 'SearchWeb', arguments: '{"query":"q"}' } },
      ],
    },
  ]);
  assert.equal(textOf(emits), 'the answer');
  assert.equal((emits.find((e: any) => e.type === 'reasoning') as any).text, 'weighing it up');
  // Normalised to the same name every other provider emits.
  assert.equal((emits.find((e: any) => e.type === 'tool') as any).name, 'WebSearch');
});

test('lines a future release adds are ignored, not fatal', () => {
  const emits = run([
    null,
    'a bare string',
    { role: 'assistant' },
    { role: 'something_new', payload: {} },
    { role: 'assistant', content: 'fine' },
  ]);
  assert.equal(textOf(emits), 'fine');
});
