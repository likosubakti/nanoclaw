import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from './cli-session-parse';

/**
 * These parsers decide whether the app tells a user they are signed in. Both
 * failure directions are costly: a false negative sends someone who is signed
 * in back through OAuth, and a false positive routes a turn through a CLI that
 * will refuse it. The cases below are the shapes the CLIs actually emit, plus
 * the shapes that would break a stricter parser.
 */

/* --------------------------------------------------------------- claude -- */

test('the real --json shape is read as a subscription session', () => {
  // Verbatim from `claude auth status --json`.
  const out = parseClaudeAuthStatus(
    '{\n  "loggedIn": true,\n  "authMethod": "oauth_token",\n  "apiProvider": "firstParty",\n  "analyticsDisabled": false,\n  "projectsDirectory": "/root/.claude/projects"\n}',
  );
  assert.deepEqual(out, { loggedIn: true, accountHint: 'signed in' });
});

test('an API key the CLI found is not a subscription', () => {
  // The whole reason for asking the CLI: a file cannot tell these apart, and
  // calling this "signed in with Claude Pro/Max" would recommend the wrong
  // transport and then fail the turn.
  const out = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key"}');
  assert.deepEqual(out, { loggedIn: false });
});

test('an unfamiliar auth method still counts as a session', () => {
  // New names appear (sso, oauth_token, …). Disbelieving one would downgrade a
  // working subscription to "please sign in".
  const out = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"sso"}');
  assert.equal(out?.loggedIn, true);
});

test('the account is named when the CLI reports one', () => {
  const out = parseClaudeAuthStatus(
    '{"loggedIn":true,"authMethod":"oauth_token","email":"a@b.com","organizationName":"Acme"}',
  );
  assert.equal(out?.accountHint, 'a@b.com · Acme');
});

test('logged out is reported as logged out', () => {
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false}'), { loggedIn: false });
});

test('JSON preceded by a warning line is still parsed', () => {
  const out = parseClaudeAuthStatus('npm warn deprecated foo\n{"loggedIn":true,"authMethod":"oauth_token"}\n');
  assert.equal(out?.loggedIn, true);
});

test('an older build that prints prose is understood', () => {
  const out = parseClaudeAuthStatus('Logged in as user@example.com');
  assert.deepEqual(out, { loggedIn: true, accountHint: 'user@example.com' });
});

test('a build with no auth subcommand yields no answer, not a false negative', () => {
  // null means "fall back to the file scan". Returning {loggedIn:false} here
  // would strand every user on a CLI predating `auth status`.
  assert.equal(parseClaudeAuthStatus(''), null);
  assert.equal(parseClaudeAuthStatus('error: unknown command "auth"'), null);
});

/* ---------------------------------------------------------------- codex -- */

test('codex reports a ChatGPT session', () => {
  const out = parseCodexLoginStatus('Logged in using ChatGPT', 0);
  assert.deepEqual(out, { loggedIn: true, accountHint: 'signed in with ChatGPT' });
});

test('codex names the account when it prints one', () => {
  const out = parseCodexLoginStatus('Logged in using ChatGPT (user@example.com)', 0);
  assert.equal(out?.accountHint, 'user@example.com');
});

test('codex authenticated by API key is not a ChatGPT subscription', () => {
  assert.deepEqual(parseCodexLoginStatus('Logged in using an API key', 0), { loggedIn: false });
});

test('codex not logged in', () => {
  assert.deepEqual(parseCodexLoginStatus('Not logged in', 1), { loggedIn: false });
});

test('an unknown codex subcommand yields no answer rather than a false negative', () => {
  assert.equal(parseCodexLoginStatus('error: unrecognized subcommand \'status\'', 2), null);
  assert.equal(parseCodexLoginStatus('Usage: codex login [OPTIONS]', 2), null);
});
