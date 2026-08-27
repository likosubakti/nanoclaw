import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { bearerForZhipu, isZhipuCompositeKey, signZhipuToken } from './zhipu-jwt';

test('recognises the bigmodel.cn id.secret key format', () => {
  assert.equal(isZhipuCompositeKey('abc123.def456'), true);
});

test('a plain z.ai key is not a composite key', () => {
  assert.equal(isZhipuCompositeKey('4f8b2c9e1a7d'), false);
});

test('a JWT is not mistaken for a composite key', () => {
  assert.equal(isZhipuCompositeKey('header.payload.signature'), false);
});

test('an empty half is not a composite key', () => {
  assert.equal(isZhipuCompositeKey('abc.'), false);
  assert.equal(isZhipuCompositeKey('.def'), false);
});

test('signs a three-part token with the documented claims', () => {
  const token = signZhipuToken('myid.mysecret', 3600);
  const parts = token.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'HS256');
  assert.equal(header.sign_type, 'SIGN');

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(payload.api_key, 'myid');
  assert.ok(payload.exp > payload.timestamp);
});

test('the signature verifies against the secret half of the key', () => {
  const token = signZhipuToken('myid.mysecret');
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', 'mysecret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  assert.equal(signature, expected);
});

test('the token is base64url, with no padding or unsafe characters', () => {
  const token = signZhipuToken('myid.mysecret');
  assert.ok(!token.includes('='), 'no padding');
  assert.ok(!token.includes('+') && !token.includes('/'), 'url-safe alphabet');
});

test('a plain key passes through as its own bearer token', () => {
  assert.equal(bearerForZhipu('sk-plain-key'), 'sk-plain-key');
});

test('a composite key is exchanged for a signed token, and cached', () => {
  const first = bearerForZhipu('cacheid.cachesecret');
  const second = bearerForZhipu('cacheid.cachesecret');
  assert.notEqual(first, 'cacheid.cachesecret');
  assert.equal(first, second, 'repeated calls must not re-sign');
});
