import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest } from '@shared/types';
import type { CliCapabilities } from '../agents/cli-detect';
import { claudeArgs } from './cli-args';

/**
 * The coding CLIs ship a coding system prompt and a full editing toolset, which
 * makes them measurably worse at open discussion than the same model reached as
 * chat. These tests pin the argument construction that turns a coding agent
 * back into a discussant — and pin the degradation path, since an unknown flag
 * is not a soft failure: the CLI exits non-zero and the turn is lost.
 */

const ALL: CliCapabilities = {
  systemPrompt: true,
  appendSystemPrompt: true,
  allowedTools: true,
  disallowedTools: true,
  tools: true,
  restricted: true,
  partialMessages: true,
  excludeDynamicSections: true,
};

/** A build old enough to have the denylist but not `--tools`. */
const LEGACY: CliCapabilities = { ...ALL, tools: false, restricted: false };

const NONE: CliCapabilities = {
  systemPrompt: false,
  appendSystemPrompt: false,
  allowedTools: false,
  disallowedTools: false,
  tools: false,
  restricted: false,
  partialMessages: false,
  excludeDynamicSections: false,
};

/** The values following a variadic flag, up to the next flag. */
function valuesAfter(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i++) out.push(args[i]);
  return out;
}

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    conversationId: 'c',
    provider: 'anthropic',
    model: 'claude-opus-5',
    transport: 'cli',
    messages: [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }],
    ...over,
  };
}

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('a chat turn empties the toolset, and does so with the flag that works', () => {
  // The subtle failure this pins: `--allowedTools` reads like a restriction and
  // is not one. Launched with it, the CLI reports all 42 built-in tools —
  // Bash, Edit, Write and Read included — pointed at the user's workspace.
  // Only `--tools` removes them, and only `--restricted` stops the user's own
  // settings files from putting them back.
  const args = claudeArgs(req({ toolPolicy: 'none' }), ALL);
  assert.ok(args.includes('--restricted'));
  assert.deepEqual(valuesAfter(args, '--tools'), [''], 'an empty --tools disables every tool');
  assert.ok(!args.includes('--allowedTools'), 'nothing to allow when nothing is available');
  assert.ok(args.includes('--system-prompt'), 'the coding prompt must be replaced, not appended');
  assert.ok(!args.includes('--append-system-prompt'));
  assert.match(valueAfter(args, '--system-prompt'), /not working on a coding task/);
});

test('a discussion turn is left with exactly the two research tools', () => {
  const args = claudeArgs(req({ toolPolicy: 'research' }), ALL);
  assert.ok(args.includes('--restricted'));
  assert.deepEqual(valuesAfter(args, '--tools'), ['WebSearch', 'WebFetch']);
  // Present in the toolset but still permission-gated, and no human is there
  // to answer a prompt.
  assert.deepEqual(valuesAfter(args, '--allowedTools'), ['WebSearch', 'WebFetch']);
  assert.match(valueAfter(args, '--system-prompt'), /search the web/);
});

test('a build without --tools still loses the coding tools, via the denylist', () => {
  for (const policy of ['none', 'research'] as const) {
    const args = claudeArgs(req({ toolPolicy: policy }), LEGACY);
    assert.ok(!args.includes('--tools'), 'must not send a flag the build does not have');
    assert.ok(!args.includes('--restricted'));
    const denied = valuesAfter(args, '--disallowedTools');
    for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task']) {
      assert.ok(denied.includes(tool), `${tool} should be denied under ${policy}`);
    }
    assert.equal(
      denied.includes('WebSearch'),
      policy === 'none',
      'research keeps the web tools; chat does not',
    );
  }
});

test('an agent turn is left entirely alone', () => {
  // The agent terminal wants the CLI's own prompt and its full toolset.
  const args = claudeArgs(req({ toolPolicy: 'full' }), ALL);
  assert.ok(!args.includes('--system-prompt'));
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('--disallowedTools'));
});

test('the default policy is full, so agent behaviour never changes by accident', () => {
  const args = claudeArgs(req(), ALL);
  assert.ok(!args.includes('--disallowedTools'));
});

test("the caller's system prompt is carried into the replacement", () => {
  const args = claudeArgs(req({ toolPolicy: 'none', systemPrompt: 'You are the CTO.' }), ALL);
  assert.match(valueAfter(args, '--system-prompt'), /You are the CTO\./);
});

test('a build without the flags degrades instead of passing unknown ones', () => {
  // An unrecognised flag makes the CLI exit non-zero and loses the turn, so
  // nothing unsupported may be emitted.
  const args = claudeArgs(req({ toolPolicy: 'none', systemPrompt: 'x' }), NONE);
  for (const flag of [
    '--system-prompt',
    '--append-system-prompt',
    '--allowedTools',
    '--disallowedTools',
    '--include-partial-messages',
    '--exclude-dynamic-system-prompt-sections',
  ]) {
    assert.ok(!args.includes(flag), `${flag} must not be sent to a build without it`);
  }
  // The essentials still have to be there.
  assert.ok(args.includes('--print') && args.includes('--output-format'));
  assert.equal(valueAfter(args, '--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'), 'stream-json requires --verbose');
});

test('an older build falls back to appending when it cannot replace', () => {
  const args = claudeArgs(req({ toolPolicy: 'none', systemPrompt: 'Be brief.' }), {
    ...ALL,
    systemPrompt: false,
  });
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(valueAfter(args, '--append-system-prompt'), 'Be brief.');
});

test('a resumed session is continued rather than replayed', () => {
  const args = claudeArgs(req({ cliSessionId: 'sess-1' }), ALL);
  assert.equal(valueAfter(args, '--resume'), 'sess-1');
});

test('the model is always passed through', () => {
  const args = claudeArgs(req({ model: 'claude-sonnet-5' }), ALL);
  assert.equal(valueAfter(args, '--model'), 'claude-sonnet-5');
});
