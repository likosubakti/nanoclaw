import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, hostOf, redactHeaders } from './http';

const url = 'https://api.z.ai/api/paas/v4/chat/completions';

test('401 explains that the key was rejected', () => {
  const error = new HttpError(401, '{"error":{"message":"invalid api key"}}', url);
  const { message, hint } = error.friendly;
  assert.equal(message, 'invalid api key');
  assert.match(hint!, /Settings/);
});

test('403 points at the endpoint/entitlement mismatch', () => {
  const { hint } = new HttpError(403, '{}', url).friendly;
  assert.match(hint!, /Coding Plan/);
});

test('429 is reported as rate limiting', () => {
  const { hint } = new HttpError(429, '', url).friendly;
  assert.match(hint!, /Rate limited|quota|retry/i);
});

test('5xx is attributed upstream', () => {
  const { hint } = new HttpError(503, '', url).friendly;
  assert.match(hint!, /upstream/i);
});

test('reads the vendor message from each provider error shape', () => {
  // OpenAI / GLM style
  assert.equal(
    new HttpError(400, '{"error":{"message":"bad model"}}', url).friendly.message,
    'bad model',
  );
  // Zhipu legacy style
  assert.equal(new HttpError(400, '{"msg":"参数错误"}', url).friendly.message, '参数错误');
  // Anthropic style
  assert.equal(
    new HttpError(400, '{"error":{"type":"invalid_request_error","message":"max_tokens"}}', url)
      .friendly.message,
    'max_tokens',
  );
});

test('falls back to a short non-JSON body', () => {
  assert.equal(new HttpError(400, 'Bad Request', url).friendly.message, 'Bad Request');
});

test('does not echo a huge HTML error page', () => {
  const body = '<html>' + 'x'.repeat(1000) + '</html>';
  const { message } = new HttpError(400, body, url).friendly;
  assert.ok(message.length < 100, 'message should be a summary, not the page');
});

test('hostOf extracts the host and tolerates junk', () => {
  assert.equal(hostOf(url), 'api.z.ai');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('redactHeaders hides every credential-bearing header', () => {
  const redacted = redactHeaders({
    authorization: 'Bearer secret-token',
    'x-api-key': 'sk-ant-secret',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  });
  assert.equal(redacted.authorization, '«redacted»');
  assert.equal(redacted['x-api-key'], '«redacted»');
  assert.equal(redacted['anthropic-version'], '2023-06-01');
  assert.equal(redacted['content-type'], 'application/json');
});
