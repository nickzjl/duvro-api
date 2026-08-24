/**
 * Runs a premium batch: for each chosen photo, generate one image per variant
 * in the pack — 3 per photo, so 21 for a 7-photo post.
 *
 * This module owns scheduling, retry, and the fallback policy. It knows
 * nothing about HTTP or about which provider is behind lib/imageProvider.js.
 *
 * THREE PROPERTIES DRIVE THE WHOLE DESIGN:
 *
 * 1. IT ALWAYS FINISHES, AND ALWAYS FINISHES IN TIME. A Vercel function is
 *    killed at maxDuration (300s, a hard ceiling on Hobby) and a killed
 *    function returns nothing at all — not partial results, not an error the
 *    app can act on. So the batch carries its own deadline, comfortably
 *    inside the function's, and stops STARTING work once the remaining budget
 *    is too small to finish a generation. Slots that never got their chance
 *    come back as fallbacks. Degrading to the app's local Core Image render is
 *    always better than the whole request dying.
 *
 * 2. ONE FAILURE NEVER FAILS THE BATCH. A slot that fails is retried once,
 *    then reported as `status: 'fallback'` with a reason. The app renders that
 *    one variant locally, exactly as it does on the free tier, and the user
 *    sees a complete set of three either way. There is no batch-level error
 *    path for generation failure — only for the request being invalid or
 *    unentitled, which is decided before any generation starts.
 *
 * 3. PROGRESS IS REPORTED AS IT HAPPENS. 21 generations is a long wait, so
 *    `onProgress` fires per completed slot rather than the caller getting one
 *    result at the end. See api/premium/generate.js for how that becomes an
 *    NDJSON stream.
 *
 * ROLLING POOL, NOT FIXED WAVES. The brief said "in waves"; this runs a
 * rolling bounded pool instead — N workers pulling from a shared queue, never
 * more than N in flight. Same concurrency ceiling, but a worker that finishes
 * early picks up the next slot immediately instead of idling until the
 * slowest member of its wave returns. Generation latency varies a lot, and
 * under a hard 300s ceiling that idle time is the difference between finishing
 * the batch and timing slots out. Strict waves would be simpler to reason
 * about; they would also throw away runway we cannot spare.
 *
 * Privacy: image URLs and bytes are never logged here. The counters this
 * returns are numeric only.
 */

import {
  ProviderTimeoutError,
  generate,
  getProvider,
  getProviderConfig,
} from './imageProvider.js';
import { isPlaceholder, loadStyleInstruction } from './styles.js';

/**
 * How much of the deadline must remain before a new generation is started.
 * Overridable per batch (`headroomMs`): the right value tracks how long a
 * generation actually takes, which is provider-specific and unknown until one
 * is chosen. 2s is a deliberately cautious default — the cost of being wrong
 * high is one extra fallback, the cost of being wrong low is the function
 * being killed mid-response and the app getting nothing at all.
 */
export const DEADLINE_HEADROOM_MS = 2_000;

/** Retry once, so at most two attempts per slot. */
export const MAX_ATTEMPTS = 2;

/**
 * Why a slot fell back to the app's local render. Surfaced per slot so the
 * app — and a human reading DEBUG output — can tell a slow provider from a
 * broken one from a batch that simply ran out of time.
 */
export const FALLBACK_REASONS = {
  TIMEOUT: 'provider_timeout',
  ERROR: 'provider_error',
  DEADLINE: 'batch_deadline',
  CANCELLED: 'cancelled',
};

/**
 * @param {object}   args
 * @param {Array}    args.photos      [{ id, url, mediaType }] — full-resolution sources
 * @param {string}   args.vibePack
 * @param {string[]} args.variants    the pack's three variant display names, in order
 * @param {number}   args.deadlineAt  epoch ms; no new generation starts after this
 * @param {Function} [args.onProgress] called with each progress event
 * @param {object}   [args.provider]  defaults to the configured one
 * @param {number}   [args.headroomMs] time that must remain before starting a slot
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{slots: Array, counts: object}>}
 */
export async function runBatch({
  photos,
  vibePack,
  variants,
  deadlineAt,
  onProgress,
  provider,
  signal,
  env = process.env,
  now = () => Date.now(),
  headroomMs = DEADLINE_HEADROOM_MS,
}) {
  const config = getProviderConfig(env);
  const impl = provider ?? getProvider(config.name);
  const concurrency = Math.max(1, config.concurrency);

  // Instructions are loaded ONCE up front, not per slot: they are the same for
  // every photo, and a missing file must surface before anything is spent.
  const instructions = new Map();
  let placeholderCount = 0;
  for (const variant of variants) {
    const text = loadStyleInstruction(vibePack, variant);
    instructions.set(variant, text);
    if (isPlaceholder(text)) placeholderCount += 1;
  }

  // Slot order is photo-major: all three variants of photo 1, then photo 2.
  // That way the app can start the edit screen on photo 1 as soon as its three
  // are in, rather than waiting for the whole batch.
  const queue = [];
  for (const photo of photos) {
    variants.forEach((variant, variantIndex) => {
      queue.push({ photo, variant, variantIndex });
    });
  }

  const slots = new Array(queue.length);
  const counts = {
    totalSlots: queue.length,
    attempted: 0,
    retried: 0,
    generated: 0,
    fellBack: 0,
    byReason: {},
  };

  emit(onProgress, {
    type: 'start',
    totalSlots: queue.length,
    photos: photos.length,
    variantsPerPhoto: variants.length,
    concurrency,
    provider: config.name,
    placeholderInstructions: placeholderCount,
  });

  let cursor = 0;
  const takeNext = () => (cursor < queue.length ? queue[cursor++] : null);

  const recordFallback = (index, task, reason, attempts) => {
    counts.fellBack += 1;
    counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
    const slot = {
      photoId: task.photo.id,
      variant: task.variant,
      variantIndex: task.variantIndex,
      status: 'fallback',
      fallbackReason: reason,
      attempts,
    };
    slots[index] = slot;
    emit(onProgress, { type: 'slot', ...slot, completed: countCompleted(slots), totalSlots: queue.length });
  };

  async function worker() {
    for (;;) {
      const index = cursor;
      const task = takeNext();
      if (task === null) return;

      if (signal?.aborted) {
        recordFallback(index, task, FALLBACK_REASONS.CANCELLED, 0);
        continue;
      }

      // Never start work that cannot finish. A generation begun with 3s left
      // is 3s of spend that produces nothing and risks the function being
      // killed mid-response, which would lose the slots already completed.
      if (now() + headroomMs >= deadlineAt) {
        recordFallback(index, task, FALLBACK_REASONS.DEADLINE, 0);
        continue;
      }

      // The per-call timeout is also clamped to what is actually left, so the
      // last generation of a batch cannot overrun the deadline on its own.
      const remaining = deadlineAt - now();
      const timeoutMs = Math.max(1, Math.min(config.timeoutMs, remaining));

      let attempts = 0;
      let lastReason = FALLBACK_REASONS.ERROR;

      while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        counts.attempted += 1;
        if (attempts > 1) counts.retried += 1;

        try {
          const result = await generate({
            image: { url: task.photo.url, mediaType: task.photo.mediaType ?? null },
            instruction: instructions.get(task.variant),
            provider: impl,
            timeoutMs,
            signal,
            env,
          });

          counts.generated += 1;
          const slot = {
            photoId: task.photo.id,
            variant: task.variant,
            variantIndex: task.variantIndex,
            status: 'generated',
            url: result.url ?? null,
            mediaType: result.mediaType ?? null,
            attempts,
          };
          slots[index] = slot;
          emit(onProgress, { type: 'slot', ...slot, completed: countCompleted(slots), totalSlots: queue.length });
          break;
        } catch (err) {
          lastReason = err instanceof ProviderTimeoutError
            ? FALLBACK_REASONS.TIMEOUT
            : FALLBACK_REASONS.ERROR;

          // A provider that says a retry cannot help is believed — a second
          // attempt would cost money and delay the fallback for nothing.
          const mayRetry = err?.retryable !== false;
          const timeLeft = deadlineAt - now() > headroomMs;
          if (attempts >= MAX_ATTEMPTS || !mayRetry || !timeLeft || signal?.aborted) {
            recordFallback(index, task, lastReason, attempts);
            break;
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  emit(onProgress, { type: 'done', counts });
  return { slots, counts };
}

function countCompleted(slots) {
  let n = 0;
  for (const s of slots) if (s !== undefined) n += 1;
  return n;
}

/** A throwing progress consumer must never take the batch down with it. */
function emit(onProgress, event) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(event);
  } catch {
    /* ignored on purpose — progress is reporting, not control flow */
  }
}
