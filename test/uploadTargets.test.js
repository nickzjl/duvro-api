/**
 * Tests for POST /api/premium/upload-targets.
 *
 * The properties that matter:
 *   - FAL_KEY never reaches the response
 *   - photo bytes never pass through the server (there is no bytes path at all)
 *   - the request fal receives matches the contract read out of @fal-ai/client
 *   - a forged/rejected device token gets nothing minted
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import handler, { MAX_UPLOAD_TARGETS, validateRequest } from '../api/premium/upload-targets.js';
import { _resetJwtCache } from '../lib/devicecheck.js';
import { classifyFalError, getFalConfig, uploadLifecycleHeaders, outputLifecycleHeaders, authHeaders } from '../lib/fal.js';

const { privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const FAL_KEY = 'fal-secret-key-do-not-leak';
const BASE_ENV = {
  APPLE_DEVICECHECK_KEY: privateKey,
  APPLE_DEVICECHECK_KEY_ID: 'TESTKEYID1',
  APPLE_TEAM_ID: 'TESTTEAM01',
  FAL_KEY,
};
const TOKEN = Buffer.from('t'.repeat(64)).toString('base64');
const files = (n, contentType = 'image/jpeg') =>
  Array.from({ length: n }, () => ({ contentType }));

/** Apple says "fresh device"; fal mints sequential targets. */
function harness({ falStatus = 200, falBody = null, falHeaders = {} } = {}) {
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('devicecheck')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => 'Failed to find bit state' };
    }
    n += 1;
    const body = falBody ?? { upload_url: `https://upload.fal.example/sig/${n}`, file_url: `https://v3.fal.media/files/x/${n}.jpg` };
    return {
      ok: falStatus >= 200 && falStatus < 300,
      status: falStatus,
      headers: new Headers(falHeaders),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { calls, falCalls: () => calls.filter((c) => !c.url.includes('devicecheck')) };
}

async function call(body, { method = 'POST', env = BASE_ENV } = {}) {
  for (const k of ['APPLE_DEVICECHECK_KEY', 'APPLE_DEVICECHECK_KEY_ID', 'APPLE_TEAM_ID', 'FAL_KEY',
                   'FAL_REST_HOST', 'FAL_OBJECT_EXPIRY_SECONDS', 'FAL_STORAGE_TYPE']) delete process.env[k];
  Object.assign(process.env, env);
  _resetJwtCache();
  let status, payload;
  const res = {
    set statusCode(v) { status = v; }, get statusCode() { return status; },
    setHeader() {}, end(s) { payload = s; },
  };
  await handler({ method, body }, res);
  return { status, body: JSON.parse(payload) };
}

/* ------------------------------------------------------------------ */

test('rejects non-POST', async () => {
  harness();
  const r = await call({}, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.body.code, 'method_not_allowed');
});

test('missing FAL_KEY is a 500 that names the variable and leaks nothing', async () => {
  harness();
  const env = { ...BASE_ENV }; delete env.FAL_KEY;
  const r = await call({ deviceToken: TOKEN, files: files(1) }, { env });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'server_misconfigured');
  assert.match(r.body.error, /FAL_KEY/);
});

test('mints one target per requested file', async () => {
  const h = harness();
  const r = await call({ deviceToken: TOKEN, files: files(3) });
  assert.equal(r.status, 200);
  assert.equal(r.body.targets.length, 3);
  assert.equal(h.falCalls().length, 3);
  for (const t of r.body.targets) {
    assert.equal(t.method, 'PUT');
    assert.equal(t.headers['Content-Type'], 'image/jpeg');
    assert.match(t.uploadUrl, /^https:\/\//);
    assert.match(t.fileUrl, /^https:\/\//);
  }
});

test('calls fal with the contract read from @fal-ai/client', async () => {
  const h = harness();
  await call({ deviceToken: TOKEN, files: [{ contentType: 'image/png' }] });
  const c = h.falCalls()[0];
  assert.match(c.url, /^https:\/\/rest\.fal\.ai\/storage\/upload\/initiate\?storage_type=fal-cdn-v3$/);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.authorization, `Key ${FAL_KEY}`);
  assert.ok(!('Bearer' in c.init.headers), 'must not use Bearer');
  assert.equal(c.body.content_type, 'image/png');
  assert.match(c.body.file_name, /\.png$/);
});

test('sets the upload object-lifecycle header so photos expire off fal', async () => {
  const h = harness();
  await call({ deviceToken: TOKEN, files: files(1) });
  // fal's docs and fal's own SDK disagree on the name here, so we send both.
  const headers = h.falCalls()[0].init.headers;
  for (const name of ['x-fal-object-lifecycle', 'x-fal-object-lifecycle-preference']) {
    assert.ok(headers[name], `${name} must be present by default`);
    assert.equal(JSON.parse(headers[name]).expiration_duration_seconds, 86400);
  }
});

test('FAL_OBJECT_EXPIRY_SECONDS=0 opts out of expiry', async () => {
  const h = harness();
  await call({ deviceToken: TOKEN, files: files(1) },
    { env: { ...BASE_ENV, FAL_OBJECT_EXPIRY_SECONDS: '0' } });
  assert.equal(h.falCalls()[0].init.headers['x-fal-object-lifecycle'], undefined);
  assert.equal(h.falCalls()[0].init.headers['x-fal-object-lifecycle-preference'], undefined);
});

test('FAL_KEY never appears in the response body', async () => {
  harness();
  const r = await call({ deviceToken: TOKEN, files: files(2) });
  assert.ok(!JSON.stringify(r.body).includes(FAL_KEY));
});

test('device token is never echoed', async () => {
  harness();
  const r = await call({ deviceToken: TOKEN, files: files(1) });
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
});

test('a device token Apple rejects mints nothing', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('devicecheck')) {
      return { ok: false, status: 400, headers: new Headers(), text: async () => 'Invalid device token' };
    }
    throw new Error('fal must not be called');
  };
  _resetJwtCache();
  Object.assign(process.env, BASE_ENV);
  let status, payload;
  const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(s) { payload = s; } };
  await handler({ method: 'POST', body: { deviceToken: TOKEN, files: files(3) } }, res);
  assert.equal(status, 400);
  assert.equal(JSON.parse(payload).code, 'invalid_device_token');
  assert.ok(!calls.some((u) => u.includes('rest.fal.ai')), 'fal must not be reached');
});

test('over the cap is rejected before any fal call', async () => {
  const h = harness();
  const r = await call({ deviceToken: TOKEN, files: files(MAX_UPLOAD_TARGETS + 1) });
  assert.equal(r.status, 400);
  assert.equal(h.falCalls().length, 0);
});

test('rejects content types we do not accept', async () => {
  const errs = validateRequest({ deviceToken: TOKEN, files: [{ contentType: 'application/zip' }] });
  assert.ok(errs.some((e) => e.includes('contentType must be one of')));
});

test('file names are sanitised, never passed through raw', async () => {
  const h = harness();
  await call({ deviceToken: TOKEN, files: [{ contentType: 'image/jpeg', fileName: '../../etc/passwd; rm -rf' }] });
  const name = h.falCalls()[0].body.file_name;
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.includes('..'), name);
  assert.ok(!name.includes(' '), name);
  assert.match(name, /\.jpg$/);
});

test('a malformed fal response fails loudly rather than yielding half a target', async () => {
  harness({ falBody: { upload_url: 'https://x' } }); // file_url missing
  const r = await call({ deviceToken: TOKEN, files: files(1) });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'fal_unexpected_response');
});

test('fal auth failure surfaces as server_misconfigured, not a client error', async () => {
  harness({ falStatus: 401, falBody: 'unauthorized' });
  const r = await call({ deviceToken: TOKEN, files: files(1) });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'server_misconfigured');
});

test('fal rate limiting surfaces as 429', async () => {
  harness({ falStatus: 429, falBody: { detail: 'too many', error_type: 'concurrent_requests_limit' } });
  const r = await call({ deviceToken: TOKEN, files: files(1) });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'fal_rate_limited');
});

/* ---------------- shared fal client ---------------- */

test('auth header is Key, never Bearer', () => {
  const h = authHeaders({ key: 'abc' });
  assert.equal(h.authorization, 'Key abc');
});

test('the two lifecycle headers use fal\'s two different names', () => {
  const cfg = { expirySeconds: 60 };
  assert.ok('x-fal-object-lifecycle' in uploadLifecycleHeaders(cfg));
  assert.ok('x-fal-object-lifecycle-preference' in outputLifecycleHeaders(cfg));
});

test('error classification follows fal\'s documented retry semantics', () => {
  const H = (o) => new Headers(o);
  assert.deepEqual(
    classifyFalError(422, H({}), JSON.stringify({ detail: [{ type: 'content_policy_violation' }] })),
    { code: 'content_policy_violation', retryable: false, status: 422 });
  assert.equal(classifyFalError(422, H({}), '{}').retryable, false, '422 defaults non-retryable');
  assert.equal(classifyFalError(401, H({}), '').retryable, false);
  assert.equal(classifyFalError(401, H({}), '').code, 'fal_auth_failed');
  assert.equal(classifyFalError(429, H({}), '').retryable, true);
  assert.equal(classifyFalError(503, H({}), '').retryable, true);
  assert.equal(classifyFalError(504, H({}), '').retryable, true);
  // fal's own retry hint wins over the status map
  assert.equal(classifyFalError(400, H({ 'x-fal-needs-retry': '1' }), '').retryable, true);
  assert.equal(classifyFalError(400, H({}), '').retryable, false);
  // header-borne error type is read too
  assert.equal(
    classifyFalError(429, H({ 'x-fal-error-type': 'concurrent_requests_limit' }), '').code,
    'fal_rate_limited');
});

test('getFalConfig validates expiry and defaults hosts', () => {
  const cfg = getFalConfig({ FAL_KEY: 'k' });
  assert.equal(cfg.restHost, 'https://rest.fal.ai');
  assert.equal(cfg.queueHost, 'https://queue.fal.run');
  assert.equal(cfg.model, 'fal-ai/flux-pro/kontext');
  assert.equal(cfg.expirySeconds, 86400);
  assert.throws(() => getFalConfig({}), /FAL_KEY/);
  assert.throws(() => getFalConfig({ FAL_KEY: 'k', FAL_OBJECT_EXPIRY_SECONDS: 'soon' }), /FAL_OBJECT_EXPIRY_SECONDS/);
});
