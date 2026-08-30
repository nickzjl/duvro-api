/**
 * Nothing reaches fal until every cheap check has passed.
 *
 * Each generation costs real money now ($0.04), so these assert the *ordering*
 * of the pre-flight rather than just its outcomes: a rejected request must not
 * produce a single call to queue.fal.run, and a misconfigured provider must be
 * a 500 before the stream commits the response to 200.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { format } from 'node:util';

import handler, { MAX_PHOTOS } from '../api/premium/generate.js';
import { _resetJwtCache } from '../lib/devicecheck.js';

const { privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const FAL_ENV = {
  APPLE_DEVICECHECK_KEY: privateKey,
  APPLE_DEVICECHECK_KEY_ID: 'TESTKEYID1',
  APPLE_TEAM_ID: 'TESTTEAM01',
  IMAGE_PROVIDER: 'fal',
  FAL_KEY: 'fal-test-key',
  FAL_POLL_INITIAL_MS: '1',
};
const TOKEN = Buffer.from('g'.repeat(64)).toString('base64');
const photos = (n) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, url: `https://v3.fal.media/files/in/${i}.jpg`, mediaType: 'image/jpeg',
}));

/** Records every outbound call so we can prove fal was never reached. */
function spy({ bit0 = false } = {}) {
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('devicecheck')) {
      return {
        ok: true, status: 200, headers: new Headers(),
        text: async () => (bit0
          ? JSON.stringify({ bit0: true, bit1: false, last_update_time: '2026-08' })
          : 'Failed to find bit state'),
      };
    }
    throw new Error(`unexpected call to ${u}`);
  };
  return { urls, falCalls: () => urls.filter((u) => u.includes('fal.run') || u.includes('fal.ai')) };
}

async function call(body, { env = FAL_ENV } = {}) {
  for (const k of Object.keys(FAL_ENV)) delete process.env[k];
  delete process.env.IMAGE_PROVIDER_CONCURRENCY;
  Object.assign(process.env, env);
  _resetJwtCache();
  let status; const chunks = [];
  const res = {
    set statusCode(v) { status = v; }, get statusCode() { return status; },
    setHeader() {}, write(c) { chunks.push(c); return true; }, end(c) { if (c) chunks.push(c); },
    on() {}, off() {},
  };
  await handler({ method: 'POST', body }, res);
  return { status, raw: chunks.join('') };
}

test('over the generation cap: 400, and fal is never called', async () => {
  const s = spy();
  const r = await call({ deviceToken: TOKEN, vibePack: 'golden_hour', photos: photos(MAX_PHOTOS + 1) });
  assert.equal(r.status, 400);
  assert.equal(s.falCalls().length, 0, 'no fal call may precede a cap rejection');
});

test('spent entitlement: 402, and fal is never called', async () => {
  const s = spy({ bit0: true });
  const r = await call({ deviceToken: TOKEN, vibePack: 'golden_hour', photos: photos(3) });
  assert.equal(r.status, 402);
  assert.equal(s.falCalls().length, 0, 'no fal call may precede an entitlement rejection');
});

test('unknown pack: 400, and fal is never called', async () => {
  const s = spy();
  const r = await call({ deviceToken: TOKEN, vibePack: 'sepia', photos: photos(2) });
  assert.equal(r.status, 400);
  assert.equal(s.falCalls().length, 0);
});

test('IMAGE_PROVIDER=fal with no FAL_KEY is a 500 before the stream opens', async () => {
  const s = spy();
  const env = { ...FAL_ENV }; delete env.FAL_KEY;
  const r = await call({ deviceToken: TOKEN, vibePack: 'golden_hour', photos: photos(2) }, { env });
  assert.equal(r.status, 500, 'must not open the stream and fall back 6 times');
  assert.match(r.raw, /FAL_KEY/);
  assert.equal(s.falCalls().length, 0);
  assert.equal(s.urls.length, 0, 'not even the entitlement round trip is spent');
});

test('the cap is enforced before the entitlement round trip', async () => {
  const s = spy();
  await call({ deviceToken: TOKEN, vibePack: 'golden_hour', photos: photos(MAX_PHOTOS + 1) });
  assert.equal(s.urls.length, 0, 'a request that cannot be served should not cost a DeviceCheck call');
});

test('the cost log line carries counts only — no URL, no token', async (t) => {
  // Stub provider so the batch actually runs; the assertion is about the log.
  const s = spy();
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(format(...args));
  t.after(() => { console.log = original; });

  const url = 'https://v3.fal.media/files/in/secret-photo.jpg';
  await call({
    deviceToken: TOKEN, vibePack: 'golden_hour',
    photos: [{ id: 'p0', url, mediaType: 'image/jpeg' }],
  }, { env: { ...FAL_ENV, IMAGE_PROVIDER: 'stub', FAL_KEY: undefined } });

  const joined = lines.join('\n');
  assert.ok(joined.includes('[premium]'), 'the cost line must be emitted');
  assert.ok(!joined.includes(url), 'image URL must never be logged');
  assert.ok(!joined.includes('secret-photo'), 'no part of the URL either');
  assert.ok(!joined.includes(TOKEN), 'device token must never be logged');
  assert.match(joined, /photos=1 slots=3/);
});
