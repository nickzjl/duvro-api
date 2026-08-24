/**
 * Tests for POST /api/premium/generate.
 *
 * The property that matters most: NOTHING IS SPENT ON A REQUEST THAT SHOULD
 * HAVE BEEN REJECTED. Every rejection has to land before the first byte is
 * written, both because that is the spec and because writing a byte commits
 * the response to 200.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { format } from 'node:util';

import handler, { MAX_PHOTOS, MAX_GENERATIONS, validateRequest, validateImageUrl } from '../api/premium/generate.js';
import { _resetJwtCache } from '../lib/devicecheck.js';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const { privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const APPLE_ENV = {
  APPLE_DEVICECHECK_KEY: privateKey,
  APPLE_DEVICECHECK_KEY_ID: 'TESTKEYID1',
  APPLE_TEAM_ID: 'TESTTEAM01',
  APPLE_DEVICECHECK_ENV: 'development',
};

const DEVICE_TOKEN = Buffer.from('a-plausible-device-token-value').toString('base64');

function makeRes() {
  const chunks = [];
  return {
    statusCode: null,
    headers: {},
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(String(chunk)); this.ended = true; },
    on() {}, off() {},
    get body() { return chunks.join(''); },
    /** Parsed NDJSON lines. */
    get events() {
      return this.body.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    },
    /** Parsed as a single JSON object (the non-streaming error path). */
    get json() { return JSON.parse(this.body); },
  };
}

const photos = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    url: `https://images.example.com/${i + 1}.jpg`,
    mediaType: 'image/jpeg',
  }));

const validBody = (over = {}) => ({
  deviceToken: DEVICE_TOKEN,
  vibePack: 'golden_hour',
  photos: photos(2),
  ...over,
});

/**
 * Installs env + a stubbed Apple fetch. `bit0` drives the entitlement answer.
 * Returns a counter so a test can assert Apple was (or was not) called at all.
 */
function withApple({ bit0 = false, env = {} } = {}) {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, APPLE_ENV, env);
  _resetJwtCache();

  const state = { appleCalls: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).includes('devicecheck')) {
      state.appleCalls += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({ bit0, bit1: false, last_update_time: '2026-08' }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  state.restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in previousEnv)) delete process.env[k];
    Object.assign(process.env, previousEnv);
    globalThis.fetch = previousFetch;
    _resetJwtCache();
  };
  return state;
}

/* ------------------------------------------------------------------ */
/* Method and shape                                                    */
/* ------------------------------------------------------------------ */

test('GET is rejected', async () => {
  const apple = withApple();
  try {
    const res = makeRes();
    await handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.json.code, 'method_not_allowed');
  } finally { apple.restore(); }
});

test('a malformed body is a 400 that does not quote the body', async () => {
  const apple = withApple();
  try {
    const res = makeRes();
    // A body that readJsonBody cannot parse: a string that is not JSON.
    await handler({ method: 'POST', body: '{not json' }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.code, 'invalid_request');
    assert.ok(!res.body.includes('not json'));
  } finally { apple.restore(); }
});

/* ------------------------------------------------------------------ */
/* Validation — pure, no Apple round trip needed                       */
/* ------------------------------------------------------------------ */

test('validation rejects an unknown pack and lists the valid ones', () => {
  const errors = validateRequest(validBody({ vibePack: 'golden-hour' }));
  assert.ok(errors.some((e) => e.includes('vibePack must be one of')));
});

test('validation enforces the hard per-request cap', () => {
  const errors = validateRequest(validBody({ photos: photos(MAX_PHOTOS + 1) }));
  assert.ok(errors.some((e) => e.includes(`at most ${MAX_PHOTOS}`)));
});

test(`the cap bounds generations at ${MAX_GENERATIONS}, not just photos`, () => {
  assert.equal(MAX_GENERATIONS, MAX_PHOTOS * 3);
  assert.equal(validateRequest(validBody({ photos: photos(MAX_PHOTOS) })).length, 0);
});

test('validation rejects an empty photo list', () => {
  assert.ok(validateRequest(validBody({ photos: [] })).some((e) => e.includes('must not be empty')));
});

test('validation rejects duplicate photo ids', () => {
  const dupes = [
    { id: 'same', url: 'https://images.example.com/1.jpg' },
    { id: 'same', url: 'https://images.example.com/2.jpg' },
  ];
  assert.ok(validateRequest(validBody({ photos: dupes })).some((e) => e.includes('duplicate')));
});

test('validation messages name field paths, never values', () => {
  const errors = validateRequest(validBody({
    photos: [{ id: 'p1', url: 'https://secret-bucket.example.com/private-photo.jpg?sig=SECRET' }],
    vibePack: 'nope',
  }));
  const joined = errors.join(' ');
  assert.ok(!joined.includes('SECRET'), 'a signed URL must never appear in an error');
  assert.ok(!joined.includes('private-photo'));
});

test('a valid body produces no errors', () => {
  assert.deepEqual(validateRequest(validBody()), []);
});

/* ------------------------------------------------------------------ */
/* Image URLs are a server-side-request target                         */
/* ------------------------------------------------------------------ */

test('image URLs must be https', () => {
  assert.match(validateImageUrl('http://images.example.com/a.jpg'), /https/);
  assert.equal(validateImageUrl('https://images.example.com/a.jpg'), null);
});

test('image URLs may not point at private, loopback, or metadata addresses', () => {
  for (const url of [
    'https://localhost/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://10.0.0.5/a.jpg',
    'https://192.168.1.20/a.jpg',
    'https://172.16.4.4/a.jpg',
    'https://169.254.169.254/latest/meta-data/',  // cloud metadata
  ]) {
    assert.match(validateImageUrl(url), /private or loopback/, `${url} should be rejected`);
  }
});

test('a rejected URL is described without being quoted', () => {
  const message = validateImageUrl('https://127.0.0.1/secret-path.jpg');
  assert.ok(!message.includes('secret-path'));
});

test('an optional host allowlist is enforced when set', () => {
  const previous = process.env.PREMIUM_ALLOWED_IMAGE_HOSTS;
  process.env.PREMIUM_ALLOWED_IMAGE_HOSTS = 'blob.example.com';
  try {
    assert.equal(validateImageUrl('https://blob.example.com/a.jpg'), null);
    assert.equal(validateImageUrl('https://cdn.blob.example.com/a.jpg'), null);
    assert.match(validateImageUrl('https://elsewhere.example.com/a.jpg'), /allowlist|ALLOWED/i);
  } finally {
    if (previous === undefined) delete process.env.PREMIUM_ALLOWED_IMAGE_HOSTS;
    else process.env.PREMIUM_ALLOWED_IMAGE_HOSTS = previous;
  }
});

/* ------------------------------------------------------------------ */
/* Entitlement gating                                                  */
/* ------------------------------------------------------------------ */

test('a device that already used its free post is rejected with 402, before generating', async () => {
  const apple = withApple({ bit0: true });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    assert.equal(res.statusCode, 402);
    assert.equal(res.json.code, 'entitlement_required');
    assert.equal(res.json.freePremiumPostAvailable, false);
    // A single JSON object, not a stream: nothing was generated.
    assert.ok(!res.body.includes('"type":"slot"'));
  } finally { apple.restore(); }
});

test('an invalid request never reaches Apple — rejection costs nothing at all', async () => {
  const apple = withApple();
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ vibePack: 'not-a-pack' }) }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(apple.appleCalls, 0, 'validation must precede the entitlement round trip');
  } finally { apple.restore(); }
});

test('the device token is never echoed back in any response', async () => {
  const apple = withApple({ bit0: true });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    assert.ok(!res.body.includes(DEVICE_TOKEN));
  } finally { apple.restore(); }
});

test('missing Apple configuration is a 500 before anything else happens', async () => {
  const previous = { ...process.env };
  for (const k of Object.keys(APPLE_ENV)) delete process.env[k];
  _resetJwtCache();
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.json.code, 'server_misconfigured');
  } finally {
    Object.assign(process.env, previous);
    _resetJwtCache();
  }
});

test('a bad IMAGE_PROVIDER is caught up front, not after the entitlement check', async () => {
  const apple = withApple({ env: { IMAGE_PROVIDER: 'a-model-not-chosen-yet' } });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.json.code, 'server_misconfigured');
    assert.equal(apple.appleCalls, 0);
  } finally { apple.restore(); }
});

/* ------------------------------------------------------------------ */
/* The stream                                                          */
/* ------------------------------------------------------------------ */

test('an entitled request streams NDJSON: start, a line per slot, then complete', async () => {
  const apple = withApple({ bit0: false });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ photos: photos(2) }) }, res);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /ndjson/);
    assert.equal(res.headers['cache-control'], 'no-store');

    const events = res.events;
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].totalSlots, 6);
    assert.equal(events.at(-1).type, 'complete');

    const slots = events.filter((e) => e.type === 'slot');
    assert.equal(slots.length, 6);
    assert.ok(res.ended);
  } finally { apple.restore(); }
});

test('the terminal line carries every slot, so a client that ignored progress still has the result', async () => {
  const apple = withApple({ bit0: false });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ photos: photos(3) }) }, res);

    const complete = res.events.at(-1);
    assert.equal(complete.type, 'complete');
    assert.equal(complete.slots.length, 9);
    assert.equal(complete.counts.totalSlots, 9);
    assert.equal(complete.counts.generated + complete.counts.fellBack, 9);
    for (const slot of complete.slots) {
      assert.ok(slot.photoId);
      assert.ok(slot.variant);
      assert.ok(slot.status === 'generated' || slot.status === 'fallback');
    }
  } finally { apple.restore(); }
});

test('with the stub provider every slot succeeds, and each carries a usable url', async () => {
  const apple = withApple({ bit0: false });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ photos: photos(2) }) }, res);
    const complete = res.events.at(-1);
    assert.equal(complete.counts.generated, 6);
    assert.equal(complete.counts.fellBack, 0);
    for (const slot of complete.slots) assert.ok(slot.url.startsWith('https://'));
  } finally { apple.restore(); }
});

test('a provider failure degrades to per-slot fallback, never to a failed request', async () => {
  const apple = withApple({ bit0: false, env: { IMAGE_PROVIDER_STUB_FAIL_RATE: '1' } });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ photos: photos(2) }) }, res);

    assert.equal(res.statusCode, 200, 'a total provider outage is still a 200 with fallbacks');
    const complete = res.events.at(-1);
    assert.equal(complete.counts.fellBack, 6);
    assert.equal(complete.counts.generated, 0);
    // Every slot must still be named, so the app knows all six to render locally.
    assert.equal(complete.slots.length, 6);
    assert.ok(complete.slots.every((s) => s.status === 'fallback' && s.fallbackReason));
  } finally { apple.restore(); }
});

test('all three of a pack\'s variants appear for every photo', async () => {
  const apple = withApple({ bit0: false });
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody({ vibePack: 'digicam', photos: photos(2) }) }, res);
    const complete = res.events.at(-1);
    for (const id of ['p1', 'p2']) {
      const forPhoto = complete.slots.filter((s) => s.photoId === id);
      assert.deepEqual(
        forPhoto.map((s) => s.variant).sort(),
        ['Light Leak', 'Polaroid', 'Y2K Digicam'],
      );
    }
  } finally { apple.restore(); }
});

test('no image URL or device token appears in the logged cost line', async () => {
  const apple = withApple({ bit0: false });
  const logged = [];
  const previousLog = console.log;
  // util.format, not a naive join: the handler logs with %s/%d specifiers, and
  // a stub that skipped substitution would leave "attempted=%d" in the output
  // and quietly weaken every assertion below.
  console.log = (...args) => logged.push(format(...args));
  try {
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    const all = logged.join('\n');
    assert.ok(all.includes('[premium]'), 'the cost line should be logged');
    assert.ok(!all.includes('images.example.com'), 'no image URL may be logged');
    assert.ok(!all.includes(DEVICE_TOKEN), 'no device token may be logged');
    assert.ok(/attempted=\d+/.test(all) && /generated=\d+/.test(all) && /fellBack=\d+/.test(all));
  } finally {
    console.log = previousLog;
    apple.restore();
  }
});
