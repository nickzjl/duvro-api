/**
 * Apple DeviceCheck client.
 *
 * DeviceCheck gives two bits of per-device state that Apple stores and that
 * survive app deletion and reinstall. duvro uses bit0 to mark "this device has
 * used its free premium post". There are no accounts and no database — Apple
 * holds the state, we just read and write it.
 *
 * Privacy invariants:
 *   - device tokens are device identifiers: never logged, never written to
 *     disk, never echoed in a response
 *   - APPLE_DEVICECHECK_KEY is read from the environment only; never logged,
 *     never included in a response
 *   - Apple's raw error text is mapped to our own codes, never forwarded
 */

import crypto from 'node:crypto';

const HOSTS = {
  production: 'https://api.devicecheck.apple.com',
  development: 'https://api.development.devicecheck.apple.com',
};

// bit0 = free premium post consumed. bit1 is reserved and always written false.
export const BIT0_FREE_PREMIUM_CONSUMED = 'bit0';

const APPLE_TIMEOUT_MS = 10_000;

// Apple accepts a JWT for a while after issue; regenerating on every request is
// unnecessary. Cached per warm instance.
const JWT_TTL_MS = 30 * 60 * 1000;
let cachedJwt = null; // { token, expiresAt, fingerprint }

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export class ConfigError extends Error {}

/**
 * Reads and validates the three Apple env vars plus the host selector.
 * Throws ConfigError with a message safe to surface (never contains the key).
 */
export function getConfig(env = process.env) {
  const missing = ['APPLE_DEVICECHECK_KEY', 'APPLE_DEVICECHECK_KEY_ID', 'APPLE_TEAM_ID']
    .filter((k) => !env[k] || String(env[k]).trim().length === 0);
  if (missing.length > 0) {
    throw new ConfigError(`missing environment variable(s): ${missing.join(', ')}`);
  }

  const rawEnvName = (env.APPLE_DEVICECHECK_ENV ?? 'production').trim().toLowerCase();
  if (!Object.hasOwn(HOSTS, rawEnvName)) {
    throw new ConfigError(
      `APPLE_DEVICECHECK_ENV must be "production" or "development" (got "${rawEnvName}")`
    );
  }

  return {
    privateKey: normalizePrivateKey(env.APPLE_DEVICECHECK_KEY),
    keyId: String(env.APPLE_DEVICECHECK_KEY_ID).trim(),
    teamId: String(env.APPLE_TEAM_ID).trim(),
    environment: rawEnvName,
    host: HOSTS[rawEnvName],
  };
}

/**
 * Accepts the .p8 contents in the shapes an env var realistically carries them:
 * real newlines, literal backslash-n, or the whole PEM base64-encoded.
 */
function normalizePrivateKey(value) {
  let key = String(value).trim();

  if (!key.includes('BEGIN')) {
    // possibly the whole PEM, base64-encoded
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) key = decoded.trim();
    } catch {
      /* fall through to the check below */
    }
  }

  key = key.replace(/\\n/g, '\n');

  if (!/-----BEGIN (EC )?PRIVATE KEY-----/.test(key)) {
    throw new ConfigError(
      'APPLE_DEVICECHECK_KEY does not look like a PEM private key ' +
      '(expected the .p8 file contents, beginning "-----BEGIN PRIVATE KEY-----")'
    );
  }
  return key;
}

/* ------------------------------------------------------------------ */
/* ES256 JWT                                                           */
/* ------------------------------------------------------------------ */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Builds the ES256 JWT Apple's DeviceCheck API expects:
 *   header  { alg: "ES256", kid: <key id> }
 *   payload { iss: <team id>, iat: <seconds> }
 *
 * JWS requires the ECDSA signature as raw r||s (64 bytes for P-256).
 * `crypto.createSign` defaults to DER, which would be rejected — Node's
 * `dsaEncoding: 'ieee-p1363'` emits the raw form directly, so no hand-rolled
 * DER unwrapping (and no dependency) is needed.
 */
export function signJwt({ privateKey, keyId, teamId }, now = Date.now()) {
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: Math.floor(now / 1000) };
  const signingInput =
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  let signature;
  try {
    signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } catch (err) {
    // Never surface the underlying message — it can quote key material.
    throw new ConfigError('APPLE_DEVICECHECK_KEY could not be used to sign (is it a valid P-256 .p8?)');
  }

  if (signature.length !== 64) {
    throw new ConfigError(
      `unexpected ES256 signature length ${signature.length} (expected 64) — is the key P-256?`
    );
  }
  return `${signingInput}.${b64url(signature)}`;
}

function getJwt(config, now = Date.now()) {
  // Rotating any of these must invalidate the cached token.
  const fingerprint = `${config.keyId}:${config.teamId}:${config.environment}`;
  if (cachedJwt && cachedJwt.expiresAt > now && cachedJwt.fingerprint === fingerprint) {
    return cachedJwt.token;
  }
  const token = signJwt(config, now);
  cachedJwt = { token, expiresAt: now + JWT_TTL_MS, fingerprint };
  return token;
}

/** Test seam — clears the per-instance JWT cache. */
export function _resetJwtCache() {
  cachedJwt = null;
}

/* ------------------------------------------------------------------ */
/* Apple error mapping                                                 */
/* ------------------------------------------------------------------ */

/**
 * Apple replies with plain-text bodies, not JSON, and the exact wording is not
 * contractual. Match on lowercase substrings and always fall through to a
 * generic kind rather than assuming an exhaustive list.
 */
export function classifyAppleResponse(status, bodyText) {
  const text = String(bodyText ?? '').trim();
  const t = text.toLowerCase();

  // A device whose bits have never been set is not an error: Apple answers 200
  // with this plain-text body instead of JSON. Treat it as bits all false.
  if (t.includes('failed to find bit state') || t.includes('bit state not found')) {
    return { kind: 'not_found' };
  }

  if (status === 200) {
    if (text.length === 0) return { kind: 'ok', body: null };   // update_two_bits
    try {
      return { kind: 'ok', body: JSON.parse(text) };
    } catch {
      return { kind: 'apple_unexpected', status };
    }
  }

  if (status === 401 || t.includes('authorization token')) {
    // Our JWT, not the caller's token — a server-side misconfiguration.
    return { kind: 'apple_auth_failed', status };
  }
  if (t.includes('unsupported device') || t.includes('device not supported')) {
    return { kind: 'unsupported_device', status };
  }
  if (t.includes('already used') || t.includes('already been used')) {
    return { kind: 'device_token_already_used', status };
  }
  if (t.includes('device token') || t.includes('devicetoken')) {
    return { kind: 'invalid_device_token', status };
  }
  if (t.includes('timestamp') || t.includes('transaction id')) {
    // Our request framing, not the caller's input.
    return { kind: 'apple_request_rejected', status };
  }
  if (status === 429) return { kind: 'rate_limited', status };
  if (status >= 500) return { kind: 'apple_unavailable', status };
  if (status === 400) return { kind: 'invalid_device_token', status };

  return { kind: 'apple_unexpected', status };
}

/* ------------------------------------------------------------------ */
/* Apple calls                                                         */
/* ------------------------------------------------------------------ */

async function callApple(config, path, extraBody, deps) {
  const fetchImpl = deps?.fetch ?? fetch;
  const now = deps?.now ?? Date.now();

  const body = {
    device_token: deps?.deviceToken,
    transaction_id: deps?.transactionId ?? crypto.randomUUID(),
    timestamp: now,                       // milliseconds; Apple rejects stale values
    ...extraBody,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPLE_TIMEOUT_MS);

  let res, text;
  try {
    res = await fetchImpl(`${config.host}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${getJwt(config, now)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') return { kind: 'apple_timeout' };
    return { kind: 'apple_unreachable' };
  } finally {
    clearTimeout(timer);
  }

  return classifyAppleResponse(res.status, text);
}

/**
 * Reads the device's two bits.
 * Resolves to { kind: 'ok', bit0, bit1, lastUpdateTime } — a device Apple has
 * no record of resolves the same way with both bits false and
 * lastUpdateTime null.
 */
export async function queryTwoBits(config, deviceToken, deps = {}) {
  const result = await callApple(config, '/v1/query_two_bits', {}, { ...deps, deviceToken });

  if (result.kind === 'not_found') {
    return { kind: 'ok', bit0: false, bit1: false, lastUpdateTime: null, fresh: true };
  }
  if (result.kind !== 'ok') return result;

  const b = result.body ?? {};
  return {
    kind: 'ok',
    bit0: b.bit0 === true,
    bit1: b.bit1 === true,
    lastUpdateTime: typeof b.last_update_time === 'string' ? b.last_update_time : null,
    fresh: false,
  };
}

/** Writes both bits. Apple has no partial update — both are always sent. */
export async function updateTwoBits(config, deviceToken, { bit0, bit1 }, deps = {}) {
  return callApple(
    config,
    '/v1/update_two_bits',
    { bit0: Boolean(bit0), bit1: Boolean(bit1) },
    { ...deps, deviceToken },
  );
}

/* ------------------------------------------------------------------ */
/* Response mapping                                                    */
/* ------------------------------------------------------------------ */

/**
 * Maps a non-ok Apple result to { status, payload } for the client.
 * Apple's raw text is intentionally dropped; only our codes and Apple's numeric
 * status cross the boundary.
 */
export function errorResponse(result) {
  switch (result.kind) {
    case 'invalid_device_token':
      return [400, {
        error: 'The device token was rejected by Apple.',
        code: 'invalid_device_token',
      }];
    case 'device_token_already_used':
      return [400, {
        error: 'This device token has already been used. Generate a fresh one.',
        code: 'device_token_already_used',
      }];
    case 'unsupported_device':
      return [400, {
        error: 'This device does not support DeviceCheck.',
        code: 'unsupported_device',
      }];
    case 'apple_auth_failed':
      return [500, {
        error: 'Apple rejected the server credentials. Check the DeviceCheck key, key id, and team id.',
        code: 'server_misconfigured',
      }];
    case 'apple_request_rejected':
      return [500, {
        error: 'Apple rejected the request framing (timestamp or transaction id).',
        code: 'server_misconfigured',
      }];
    case 'rate_limited':
      return [429, {
        error: 'Apple is rate limiting DeviceCheck requests. Retry shortly.',
        code: 'rate_limited',
      }];
    case 'apple_timeout':
      return [504, {
        error: 'Apple DeviceCheck timed out.',
        code: 'apple_timeout',
      }];
    case 'apple_unreachable':
    case 'apple_unavailable':
      return [502, {
        error: 'Apple DeviceCheck is unavailable.',
        code: 'apple_unavailable',
        appleStatus: result.status ?? null,
      }];
    default:
      return [502, {
        error: 'Unexpected response from Apple DeviceCheck.',
        code: 'apple_unexpected',
        appleStatus: result.status ?? null,
      }];
  }
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

// Apple's device tokens are base64. Bounds are deliberately loose — the goal is
// to reject obvious junk before spending a round trip, not to pin Apple's format.
const DEVICE_TOKEN_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DEVICE_TOKEN_MIN = 16;
const DEVICE_TOKEN_MAX = 8192;

/**
 * Validates a { deviceToken } body. Returns an array of messages that describe
 * the *shape* only — the token value itself is never included, since it is a
 * device identifier.
 */
export function validateDeviceTokenBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['body must be a JSON object'];
  }
  const t = body.deviceToken;
  if (typeof t !== 'string' || t.trim().length === 0) {
    return ['deviceToken must be a non-empty string'];
  }
  const trimmed = t.trim();
  if (trimmed.length < DEVICE_TOKEN_MIN || trimmed.length > DEVICE_TOKEN_MAX) {
    return [`deviceToken length must be between ${DEVICE_TOKEN_MIN} and ${DEVICE_TOKEN_MAX} characters`];
  }
  if (!DEVICE_TOKEN_RE.test(trimmed)) {
    return ['deviceToken must be base64'];
  }
  return [];
}
