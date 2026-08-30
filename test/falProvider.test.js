/**
 * Tests for lib/falProvider.js — the fal-ai/flux-pro/kontext provider.
 *
 * The request body is asserted field by field against the model's OpenAPI
 * schema, because the expensive failures here are silent-wrong rather than
 * loud: `sync_mode: true` would return a multi-MB data URI instead of a URL,
 * an integer `safety_tolerance` is a 422, and treating a failed generation as
 * a success is possible because fal has no FAILED status.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { falProvider } from '../lib/falProvider.js';
import { generate, PROVIDERS, ProviderError } from '../lib/imageProvider.js';

const ENV = {
  FAL_KEY: 'fal-test-key',
  FAL_POLL_INITIAL_MS: '1',
  FAL_POLL_MAX_MS: '2',
  FAL_OBJECT_EXPIRY_SECONDS: '3600',
};

const IMAGE = { url: 'https://v3.fal.media/files/in/photo.jpg', mediaType: 'image/jpeg' };
const INSTRUCTION = 'Apply the look described above.';

const RESULT = {
  images: [{ url: 'https://v3.fal.media/files/out/gen.jpg', width: 3024, height: 4032, content_type: 'image/jpeg' }],
  seed: 1, prompt: INSTRUCTION, has_nsfw_concepts: [false],
};

/**
 * Scripts the queue: submit -> a run of status responses -> result.
 * Returns the recorded calls so the request shape can be asserted.
 */
function falStub({ statuses = ['COMPLETED'], result = RESULT, submitStatus = 200,
                   submitBody = null, resultStatus = 200, statusHttp = 200 } = {}) {
  const calls = [];
  let statusIndex = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({
      ok: status >= 200 && status < 300, status, headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    if (init.method === 'POST' && !u.includes('/requests/')) {
      return reply(submitStatus, submitBody ?? {
        request_id: 'req-1',
        status_url: 'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/req-1/status',
        response_url: 'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/req-1/response',
        cancel_url: 'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/req-1/cancel',
        queue_position: 0,
      });
    }
    if (u.endsWith('/status')) {
      const s = statuses[Math.min(statusIndex++, statuses.length - 1)];
      if (statusHttp !== 200) return reply(statusHttp, 'boom');
      return reply(200, typeof s === 'string' ? { status: s } : s);
    }
    if (init.method === 'PUT' && u.endsWith('/cancel')) return reply(202, { status: 'CANCELLATION_REQUESTED' });
    return reply(resultStatus, result);
  };
  return {
    calls,
    submit: () => calls.find((c) => c.method === 'POST' && !c.url.includes('/requests/')),
    cancels: () => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/cancel')),
  };
}

const run = (env = ENV) => falProvider.generate({ image: IMAGE, instruction: INSTRUCTION }, env);

/* ---------------- registration ---------------- */

test('registered as `fal`, stub still the default', async () => {
  assert.equal(PROVIDERS.fal, falProvider);
  assert.equal(PROVIDERS.stub.name, 'stub');
});

test('missing FAL_KEY is a config error naming the variable', async () => {
  await assert.rejects(() => run({}), /FAL_KEY/);
});

/* ---------------- request shape ---------------- */

test('submits to the queue endpoint, not fal.run', async () => {
  const h = falStub();
  await run();
  assert.equal(h.submit().url, 'https://queue.fal.run/fal-ai/flux-pro/kontext');
  assert.ok(!h.calls.some((c) => c.url.startsWith('https://fal.run/')), 'must not use the sync endpoint');
});

test('auth is `Key`, never Bearer, on every call', async () => {
  const h = falStub({ statuses: ['IN_QUEUE', 'COMPLETED'] });
  await run();
  for (const c of h.calls) {
    assert.equal(c.headers.authorization, 'Key fal-test-key', c.url);
    assert.ok(!String(c.headers.authorization).startsWith('Bearer'));
  }
});

test('request body matches the model schema exactly', async () => {
  const h = falStub();
  await run();
  const b = h.submit().body;
  assert.equal(b.prompt, INSTRUCTION, 'instruction goes in `prompt`');
  assert.equal(b.image_url, IMAGE.url, 'source goes in `image_url`');
  assert.equal(b.num_images, 1);
  assert.equal(b.output_format, 'jpeg');
});

test('sync_mode is false — true would return a data URI, not a URL', async () => {
  const h = falStub();
  await run();
  assert.equal(h.submit().body.sync_mode, false);
});

test('safety_tolerance is a STRING (an integer is a 422)', async () => {
  const h = falStub();
  await run();
  assert.equal(typeof h.submit().body.safety_tolerance, 'string');
  assert.equal(h.submit().body.safety_tolerance, '2');
});

test('does not send aspect_ratio (would re-frame the photo) or the non-existent num_inference_steps', async () => {
  const h = falStub();
  await run();
  const b = h.submit().body;
  assert.ok(!('aspect_ratio' in b), 'aspect_ratio must be omitted');
  assert.ok(!('num_inference_steps' in b), 'num_inference_steps is not a real field on this model');
});

test('sets the output object-lifecycle preference header', async () => {
  const h = falStub();
  await run();
  const hdr = h.submit().headers['x-fal-object-lifecycle-preference'];
  assert.ok(hdr);
  assert.equal(JSON.parse(hdr).expiration_duration_seconds, 3600);
});

/* ---------------- queue flow ---------------- */

test('polls through IN_QUEUE and IN_PROGRESS to COMPLETED', async () => {
  const h = falStub({ statuses: ['IN_QUEUE', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] });
  const out = await run();
  assert.equal(out.url, RESULT.images[0].url);
  assert.equal(out.mediaType, 'image/jpeg');
  assert.ok(h.calls.filter((c) => c.url.endsWith('/status')).length >= 4);
});

test('uses the absolute URLs fal returns rather than rebuilding paths', async () => {
  const h = falStub();
  await run();
  assert.ok(h.calls.some((c) => c.url === 'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/req-1/response'));
});

test('falls back to documented paths when fal omits the URLs', async () => {
  const h = falStub({ submitBody: { request_id: 'req-9' } });
  await run();
  assert.ok(h.calls.some((c) => c.url.endsWith('/requests/req-9/status')));
});

/* ---------------- failure handling ---------------- */

test('COMPLETED carrying an error is a failure, not a success', async () => {
  falStub({ statuses: [{ status: 'COMPLETED', error: 'boom', error_type: 'internal_server_error' }] });
  await assert.rejects(run(), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'fal_generation_failed');
    assert.equal(err.retryable, true, 'internal_server_error is retryable');
    return true;
  });
});

test('content policy violation is surfaced and NOT retried', async () => {
  falStub({ statuses: [{ status: 'COMPLETED', error: 'nope', error_type: 'content_policy_violation' }] });
  await assert.rejects(run(), (err) => {
    assert.equal(err.code, 'content_policy_violation');
    assert.equal(err.retryable, false, 'retrying a policy rejection burns money for nothing');
    return true;
  });
});

test('an unrecognised error_type defaults to non-retryable', async () => {
  falStub({ statuses: [{ status: 'COMPLETED', error: 'x', error_type: 'something_new' }] });
  await assert.rejects(run(), (err) => {
    assert.equal(err.retryable, false);
    return true;
  });
});

test('422 on submit is non-retryable', async () => {
  falStub({ submitStatus: 422, submitBody: { detail: [{ type: 'image_too_large' }] } });
  await assert.rejects(run(), (err) => {
    assert.equal(err.retryable, false);
    assert.equal(err.status, 422);
    return true;
  });
});

test('401 on submit is non-retryable and flagged as auth', async () => {
  falStub({ submitStatus: 401, submitBody: 'unauthorized' });
  await assert.rejects(run(), (err) => {
    assert.equal(err.code, 'fal_auth_failed');
    assert.equal(err.retryable, false);
    return true;
  });
});

test('429 on submit is retryable', async () => {
  falStub({ submitStatus: 429, submitBody: { error_type: 'concurrent_requests_limit' } });
  await assert.rejects(run(), (err) => {
    assert.equal(err.code, 'fal_rate_limited');
    assert.equal(err.retryable, true);
    return true;
  });
});

test('a data URI in the result is rejected rather than passed on', async () => {
  falStub({ result: { images: [{ url: 'data:image/jpeg;base64,AAAA' }] } });
  await assert.rejects(run(), (err) => {
    assert.equal(err.code, 'fal_unexpected_response');
    return true;
  });
});

test('a result without images[0].url fails loudly', async () => {
  falStub({ result: { images: [] } });
  await assert.rejects(run(), /images/);
});

test('a transient failed poll does not fail the generation', async () => {
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const reply = (s, b) => ({ ok: s < 300, status: s, headers: new Headers(), text: async () => JSON.stringify(b) });
    if (init.method === 'POST' && !u.includes('/requests/')) return reply(200, { request_id: 'r' });
    if (u.endsWith('/status')) {
      n += 1;
      if (n === 1) throw new TypeError('network blip');
      return reply(200, { status: 'COMPLETED' });
    }
    return reply(200, RESULT);
  };
  const out = await run();
  assert.equal(out.url, RESULT.images[0].url);
});

/* ---------------- cancellation ---------------- */

test('aborting mid-poll stops, and cancels the fal request to stop the meter', async () => {
  const h = falStub({ statuses: ['IN_PROGRESS'] });
  const controller = new AbortController();
  const p = falProvider.generate(
    { image: IMAGE, instruction: INSTRUCTION, signal: controller.signal }, ENV);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'fal_aborted');
    assert.equal(err.retryable, false);
    return true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.cancels().length, 1, 'must PUT the cancel URL');
});

/* ---------------- integration with the timeout wrapper ---------------- */

test('the shared generate() timeout still bounds a stuck fal call', async () => {
  falStub({ statuses: ['IN_PROGRESS'] }); // never completes
  await assert.rejects(
    generate({
      image: IMAGE, instruction: INSTRUCTION, provider: falProvider,
      timeoutMs: 60, env: { ...ENV, IMAGE_PROVIDER: 'fal' },
    }),
    (err) => { assert.equal(err.code, 'provider_timeout'); return true; });
});
