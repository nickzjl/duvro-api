/**
 * Tests for the batch orchestrator.
 *
 * The properties worth protecting are the ones that only show up under
 * failure: one bad generation must not take the batch down, a slow provider
 * must not run past the function's own deadline, and the caller must be able
 * to tell exactly which slots fell back and why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_REASONS, MAX_ATTEMPTS, runBatch } from '../lib/premiumBatch.js';
import { ProviderError, ProviderTimeoutError } from '../lib/imageProvider.js';
import { PACK_VARIANTS } from '../lib/styles.js';

const VARIANTS = PACK_VARIANTS.golden_hour;

const photos = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    url: `https://example.invalid/${i + 1}.jpg`,
    mediaType: 'image/jpeg',
  }));

/** A provider whose behaviour is scripted per call. */
function scripted(fn) {
  let calls = 0;
  return {
    name: 'scripted',
    generate: async (args) => fn(++calls, args),
    get calls() { return calls; },
  };
}

const ok = { name: 'ok', generate: async ({ image }) => ({ url: image.url, mediaType: 'image/jpeg' }) };

const farDeadline = () => Date.now() + 60_000;

/* ------------------------------------------------------------------ */
/* Happy path                                                          */
/* ------------------------------------------------------------------ */

test('produces three slots per photo, in photo-major order', async () => {
  const { slots, counts } = await runBatch({
    photos: photos(7), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: ok, env: {},
  });

  assert.equal(slots.length, 21);
  assert.equal(counts.totalSlots, 21);
  assert.equal(counts.generated, 21);
  assert.equal(counts.fellBack, 0);

  // photo-major: p1's three variants first, so the app can open the edit
  // screen on photo 1 without waiting for the whole batch
  assert.deepEqual(slots.slice(0, 3).map((s) => s.photoId), ['p1', 'p1', 'p1']);
  assert.deepEqual(slots.slice(0, 3).map((s) => s.variant), VARIANTS);
  assert.deepEqual(slots.slice(3, 6).map((s) => s.photoId), ['p2', 'p2', 'p2']);
});

test('every slot names its photo and variant so the app can place it', async () => {
  const { slots } = await runBatch({
    photos: photos(2), vibePack: 'digicam', variants: PACK_VARIANTS.digicam,
    deadlineAt: farDeadline(), provider: ok, env: {},
  });
  for (const slot of slots) {
    assert.ok(slot.photoId);
    assert.ok(PACK_VARIANTS.digicam.includes(slot.variant));
    assert.equal(typeof slot.variantIndex, 'number');
    assert.equal(slot.status, 'generated');
  }
});

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

test('never exceeds the configured concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const tracking = {
    name: 'tracking',
    generate: async ({ image }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { url: image.url, mediaType: 'image/jpeg' };
    },
  };

  await runBatch({
    photos: photos(7), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: tracking,
    env: { IMAGE_PROVIDER_CONCURRENCY: '4' },
  });

  assert.ok(peak <= 4, `peak in-flight ${peak} exceeded the limit of 4`);
  assert.ok(peak > 1, 'expected real concurrency, not serial execution');
});

test('concurrency of 1 still completes the whole batch, just serially', async () => {
  let peak = 0;
  let inFlight = 0;
  const tracking = {
    name: 'tracking',
    generate: async ({ image }) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { url: image.url, mediaType: 'image/jpeg' };
    },
  };
  const { counts } = await runBatch({
    photos: photos(3), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: tracking,
    env: { IMAGE_PROVIDER_CONCURRENCY: '1' },
  });
  assert.equal(peak, 1);
  assert.equal(counts.generated, 9);
});

test('a rolling pool keeps working while one slot is slow, rather than idling', async () => {
  // One deliberately slow call. With strict waves the two fast workers would
  // idle until it returned; with a rolling pool they keep draining the queue.
  let started = 0;
  const uneven = {
    name: 'uneven',
    generate: async ({ image }) => {
      const n = ++started;
      await new Promise((r) => setTimeout(r, n === 1 ? 60 : 1));
      return { url: image.url, mediaType: 'image/jpeg' };
    },
  };
  const t0 = Date.now();
  const { counts } = await runBatch({
    photos: photos(3), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: uneven,
    env: { IMAGE_PROVIDER_CONCURRENCY: '3' },
  });
  const elapsed = Date.now() - t0;
  assert.equal(counts.generated, 9);
  // 9 slots, one 60ms straggler, 3 workers: a rolling pool finishes in roughly
  // the straggler's own time. Strict waves would cost ~3 wave-lengths.
  assert.ok(elapsed < 150, `took ${elapsed}ms — suggests waves, not a rolling pool`);
});

/* ------------------------------------------------------------------ */
/* Retry and fallback                                                  */
/* ------------------------------------------------------------------ */

test('a failing generation is retried exactly once, then succeeds', async () => {
  const flaky = scripted(async (n, { image }) => {
    if (n === 1) throw new ProviderError('transient');
    return { url: image.url, mediaType: 'image/jpeg' };
  });

  const { slots, counts } = await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: [VARIANTS[0]],
    deadlineAt: farDeadline(), provider: flaky, env: {},
  });

  assert.equal(slots[0].status, 'generated');
  assert.equal(slots[0].attempts, 2);
  assert.equal(counts.retried, 1);
  assert.equal(counts.generated, 1);
});

test('a slot failing twice falls back — it does not fail the batch', async () => {
  const alwaysFails = { name: 'bad', generate: async () => { throw new ProviderError('nope'); } };

  const { slots, counts } = await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: [VARIANTS[0]],
    deadlineAt: farDeadline(), provider: alwaysFails, env: {},
  });

  assert.equal(slots[0].status, 'fallback');
  assert.equal(slots[0].fallbackReason, FALLBACK_REASONS.ERROR);
  assert.equal(slots[0].attempts, MAX_ATTEMPTS);
  assert.equal(counts.fellBack, 1);
});

test('one bad slot among many leaves every other slot generated', async () => {
  // Fail only the calls for photo p2's first variant.
  const selective = {
    name: 'selective',
    generate: async ({ image }) => {
      if (image.url.endsWith('/2.jpg')) throw new ProviderError('nope');
      return { url: image.url, mediaType: 'image/jpeg' };
    },
  };

  const { slots, counts } = await runBatch({
    photos: photos(3), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: selective, env: {},
  });

  assert.equal(slots.length, 9);
  assert.equal(counts.fellBack, 3);      // all three variants of p2
  assert.equal(counts.generated, 6);
  const fellBack = slots.filter((s) => s.status === 'fallback');
  assert.deepEqual([...new Set(fellBack.map((s) => s.photoId))], ['p2']);
});

test('a timeout falls back with a reason distinguishable from a plain error', async () => {
  const slow = { name: 'slow', generate: () => new Promise(() => {}) };
  const { slots, counts } = await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: [VARIANTS[0]],
    deadlineAt: farDeadline(), provider: slow,
    env: { IMAGE_PROVIDER_TIMEOUT_MS: '1000' },
  });
  assert.equal(slots[0].status, 'fallback');
  assert.equal(slots[0].fallbackReason, FALLBACK_REASONS.TIMEOUT);
  assert.equal(counts.byReason[FALLBACK_REASONS.TIMEOUT], 1);
});

test('a provider that says retry is pointless is believed — no second attempt', async () => {
  let calls = 0;
  const permanent = {
    name: 'permanent',
    generate: async () => {
      calls += 1;
      throw new ProviderError('content rejected', { code: 'content_rejected', retryable: false });
    },
  };

  const { slots, counts } = await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: [VARIANTS[0]],
    deadlineAt: farDeadline(), provider: permanent, env: {},
  });

  assert.equal(calls, 1, 'a non-retryable failure must not be retried');
  assert.equal(counts.retried, 0);
  assert.equal(slots[0].status, 'fallback');
  assert.equal(slots[0].attempts, 1);
});

/* ------------------------------------------------------------------ */
/* The deadline                                                        */
/* ------------------------------------------------------------------ */

test('slots that cannot start before the deadline fall back rather than being dropped', async () => {
  // Deadline already passed: nothing may start, but every slot must still be
  // accounted for, because the app needs all 9 to render a complete post.
  const { slots, counts } = await runBatch({
    photos: photos(3), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: Date.now() - 1, provider: ok, env: {},
  });

  assert.equal(slots.length, 9);
  assert.equal(counts.generated, 0);
  assert.equal(counts.fellBack, 9);
  assert.equal(counts.byReason[FALLBACK_REASONS.DEADLINE], 9);
  assert.ok(slots.every((s) => s.status === 'fallback'));
});

test('a batch that runs out of time mid-way returns a mix, never a partial array', async () => {
  const slowish = {
    name: 'slowish',
    generate: async ({ image }) => {
      await new Promise((r) => setTimeout(r, 20));
      return { url: image.url, mediaType: 'image/jpeg' };
    },
  };

  // headroomMs scaled down to match the miniature deadline — production's 2s
  // default assumes generations that take seconds, not the 20ms used here.
  const { slots, counts } = await runBatch({
    photos: photos(10), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: Date.now() + 200, provider: slowish, headroomMs: 25,
    env: { IMAGE_PROVIDER_CONCURRENCY: '2' },
  });

  assert.equal(slots.length, 30, 'every slot must be present, generated or not');
  assert.ok(slots.every((s) => s !== undefined));
  assert.equal(counts.generated + counts.fellBack, 30);
  assert.ok(counts.generated > 0, 'expected some work to complete before the deadline');
  assert.ok(counts.byReason[FALLBACK_REASONS.DEADLINE] > 0, 'expected some slots cut off by the deadline');
});

test('the per-call timeout is clamped to the time actually remaining', async () => {
  // Timeout configured at 60s but only ~50ms of deadline left: the call must
  // be cut at the deadline, not run 60s past it.
  const slow = { name: 'slow', generate: () => new Promise(() => {}) };
  const t0 = Date.now();
  await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: [VARIANTS[0]],
    deadlineAt: Date.now() + 150, provider: slow, headroomMs: 25,
    env: { IMAGE_PROVIDER_TIMEOUT_MS: '60000' },
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `took ${elapsed}ms — the per-call timeout ignored the deadline`);
});

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

test('progress fires start, one event per slot, then done', async () => {
  const events = [];
  const { counts } = await runBatch({
    photos: photos(2), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: ok, env: {},
    onProgress: (e) => events.push(e),
  });

  assert.equal(events[0].type, 'start');
  assert.equal(events[0].totalSlots, 6);
  assert.equal(events[0].concurrency > 0, true);
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(events.at(-1).counts, counts);

  const slotEvents = events.filter((e) => e.type === 'slot');
  assert.equal(slotEvents.length, 6);
  // `completed` must climb monotonically — it drives the app's progress bar.
  const completed = slotEvents.map((e) => e.completed);
  assert.deepEqual(completed, [...completed].sort((a, b) => a - b));
  assert.equal(completed.at(-1), 6);
});

test('progress reports placeholder instructions, so a wrong look is never mistaken for an unwritten one', async () => {
  const events = [];
  await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: ok, env: {},
    onProgress: (e) => events.push(e),
  });
  // All nine instructions are now written, so this is 0. The field still earns
  // its place: it is how an unwritten instruction would surface in DEBUG rather
  // than being mistaken for a wrong-looking render.
  assert.equal(events[0].placeholderInstructions, 0);
});

test('a throwing progress consumer does not take the batch down', async () => {
  const { counts } = await runBatch({
    photos: photos(1), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: ok, env: {},
    onProgress: () => { throw new Error('the client hung up'); },
  });
  assert.equal(counts.generated, 3);
});

/* ------------------------------------------------------------------ */
/* Cancellation and counters                                           */
/* ------------------------------------------------------------------ */

test('an aborted batch still accounts for every slot', async () => {
  const controller = new AbortController();
  controller.abort();
  const { slots, counts } = await runBatch({
    photos: photos(2), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: ok, signal: controller.signal, env: {},
  });
  assert.equal(slots.length, 6);
  assert.equal(counts.fellBack, 6);
  assert.equal(counts.byReason[FALLBACK_REASONS.CANCELLED], 6);
});

test('counters add up and are numeric only — safe to log', async () => {
  const flaky = scripted(async (n, { image }) => {
    if (n % 3 === 0) throw new ProviderError('transient');
    return { url: image.url, mediaType: 'image/jpeg' };
  });
  const { counts } = await runBatch({
    photos: photos(3), vibePack: 'golden_hour', variants: VARIANTS,
    deadlineAt: farDeadline(), provider: flaky,
    env: { IMAGE_PROVIDER_CONCURRENCY: '1' },
  });

  assert.equal(counts.generated + counts.fellBack, counts.totalSlots);
  assert.ok(counts.attempted >= counts.totalSlots);
  for (const [key, value] of Object.entries(counts)) {
    if (key === 'byReason') continue;
    assert.equal(typeof value, 'number', `${key} must be numeric`);
  }
  // Nothing in the counters can carry a URL or image data.
  assert.ok(!JSON.stringify(counts).includes('example.invalid'));
});

test('an unknown variant fails before any generation is attempted', async () => {
  let called = false;
  const watched = { name: 'watched', generate: async () => { called = true; return {}; } };
  await assert.rejects(
    runBatch({
      photos: photos(1), vibePack: 'golden_hour', variants: ['Not A Real Variant'],
      deadlineAt: farDeadline(), provider: watched, env: {},
    }),
    /unknown variant/,
  );
  assert.equal(called, false, 'nothing should be spent on a batch that cannot be configured');
});
