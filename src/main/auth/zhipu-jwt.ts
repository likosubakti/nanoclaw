import { createHmac } from 'node:crypto';

/**
 * open.bigmodel.cn issues keys in an `{id}.{secret}` form and expects a short
 * lived HS256 JWT rather than the raw key. The international z.ai platform
 * accepts the raw key as a bearer token. Detecting the format lets one key
 * field serve both platforms.
 */

export function isZhipuCompositeKey(key: string): boolean {
  const parts = key.split('.');
  // A JWT has three segments; a composite key has exactly two, both non-empty.
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/** Builds the signed token bigmodel.cn expects. Valid for `ttlSeconds`. */
export function signZhipuToken(key: string, ttlSeconds = 3600): string {
  const [id, secret] = key.split('.');
  const now = Date.now();

  const header = { alg: 'HS256', sign_type: 'SIGN' };
  const payload = {
    api_key: id,
    exp: now + ttlSeconds * 1000,
    timestamp: now,
  };

  const encode = (value: object) => base64Url(Buffer.from(JSON.stringify(value), 'utf8'));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = base64Url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cache tokens so a burst of requests does not re-sign on every call. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function bearerForZhipu(key: string): string {
  if (!isZhipuCompositeKey(key)) return key;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const token = signZhipuToken(key);
  tokenCache.set(key, { token, expiresAt: Date.now() + 3600_000 });
  return token;
}
