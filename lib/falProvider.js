/**
 * The fal.ai image-generation provider — fal-ai/flux-pro/kontext.
 *
 * Takes { image: { url }, instruction } and returns the generated image's CDN
 * URL. Registered in lib/imageProvider.js as `fal`; selected with
 * IMAGE_PROVIDER=fal. The stub stays available for testing without spending.
 *
 * ── QUEUE, NOT SYNC ──────────────────────────────────────────────────────
 * fal offers both `POST https://fal.run/{model}` (synchronous, response on the
 * same connection) and `POST https://queue.fal.run/{model}` (submit, poll,
 * fetch). This uses the queue, for three reasons:
 *
 * 1. CONTENTION BECOMES WAITING, NOT FAILURE. fal's docs are explicit that
 *    fal.run has "no queue". Concurrency limits are per ACCOUNT, not per
 *    request, so two devices generating at once put 2x our configured
 *    concurrency against the same cap. On the sync endpoint the excess returns
 *    429 immediately, which — after our retry-once — becomes a user-visible
 *    fallback. On the queue they wait and complete.
 * 2. NO LONG-HELD CONNECTION. A sync call parks one HTTP connection for the
 *    whole generation. The queue's calls are each sub-second, so nothing is
 *    exposed to an intermediary's idle timeout, and fal documents no maximum
 *    duration for fal.run that we could design against.
 * 3. FAILURES ARRIVE STRUCTURED. A queue failure comes back as status
 *    COMPLETED carrying `error_type`, which maps directly onto our
 *    retryable/non-retryable policy. There is no FAILED status — checking only
 *    for one would hang until the deadline.
 *
 * The cost is one extra round trip plus polling. That is paid for by the
 * batch's existing per-call timeout, which is already clamped to the remaining
 * deadline — polling simply happens inside that window, and the caller's
 * AbortSignal ends it.
 *
 * Privacy: image URLs, instructions and bytes are never logged.
 */

import {
  authHeaders,
  classifyFalError,
  getFalConfig,
  outputLifecycleHeaders,
} from './fal.js';
import { ProviderError } from './providerErrors.js';

/** Poll cadence: quick at first, backing off. Kontext is typically seconds. */
export const POLL_INITIAL_MS = 500;
export const POLL_MAX_MS = 3_000;
export const POLL_BACKOFF = 1.35;

const SUBMIT_TIMEOUT_MS = 20_000;

/** Requested output format. See README for the png-vs-jpeg tradeoff. */
export const OUTPUT_FORMAT = 'jpeg';
const mediaTypeForOutputFormat = (f) => (f === 'png' ? 'image/png' : 'image/jpeg');
const POLL_TIMEOUT_MS = 15_000;

/**
 * fal's request/infra error_type values that a second attempt can plausibly
 * fix. Everything else — validation, content policy, anything unrecognised —
 * is treated as non-retryable, which is fal's own documented default for
 * unknown types.
 */
const RETRYABLE_ERROR_TYPES = new Set([
  'request_timeout', 'startup_timeout', 'generation_timeout',
  'runner_scheduling_failure', 'runner_disconnected', 'runner_server_error',
  'runner_connection_refused', 'runner_connection_timeout', 'runner_connection_error',
  'runner_incomplete_response', 'internal_server_error', 'internal_error',
  'downstream_service_unavailable', 'concurrent_requests_limit',
]);

export const falProvider = {
  name: 'fal',

  /**
   * Pre-flight credential check. Without this, a deployment with
   * IMAGE_PROVIDER=fal and no FAL_KEY would pass the endpoint's config checks,
   * consume an entitlement round trip, open the stream, and only then fail on
   * every single slot — reporting 30 fallbacks for what is really one missing
   * env var.
   */
  validateConfig(env = process.env) {
    getFalConfig(env);
  },

  async generate({ image, instruction, signal }, env = process.env) {
    const config = getFalConfig(env);
    // Overridable so tests do not have to wait out real poll intervals.
    const poll = {
      initialMs: numFromEnv(env, 'FAL_POLL_INITIAL_MS', POLL_INITIAL_MS),
      maxMs: numFromEnv(env, 'FAL_POLL_MAX_MS', POLL_MAX_MS),
    };
    const submitted = await submit({ config, image, instruction, signal });

    try {
      await pollUntilComplete({ config, submitted, signal, poll });
      return await fetchResult({ config, submitted, signal });
    } catch (err) {
      // Stop paying for work nobody will collect. Best effort: a failed cancel
      // must never mask the real error.
      cancel({ config, submitted }).catch(() => {});
      throw err;
    }
  },
};

/* ------------------------------------------------------------------ */

function falFetch(url, { config, method = 'GET', body, signal, timeoutMs, extraHeaders }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  return (async () => {
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          ...authHeaders(config),
          ...(extraHeaders ?? {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  })();
}

function parseJson(text, whatFailed) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${whatFailed} returned invalid JSON`, {
      code: 'fal_unexpected_response',
      retryable: true,
    });
  }
}

function raiseHttp(res, text, whatFailed) {
  const { code, retryable, status } = classifyFalError(res.status, res.headers, text);
  throw new ProviderError(whatFailed, { code, retryable, status });
}

async function submit({ config, image, instruction, signal }) {
  const url = `${config.queueHost}/${config.model}`;

  let out;
  try {
    out = await falFetch(url, {
      config,
      method: 'POST',
      signal,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      extraHeaders: outputLifecycleHeaders(config),
      body: {
        // Verified against the model's OpenAPI schema. `prompt` is the edit
        // instruction and `image_url` the source; both are required.
        prompt: instruction,
        image_url: image.url,
        num_images: 1,
        output_format: OUTPUT_FORMAT,
        // MUST stay false. `sync_mode: true` makes fal return the image as a
        // data URI instead of a CDN URL — which is precisely the payload shape
        // this whole architecture exists to avoid.
        sync_mode: false,
        // A STRING in the schema, not an integer. Sending 2 is a 422.
        safety_tolerance: '2',
        // aspect_ratio is deliberately omitted: it has no default, and setting
        // one would re-frame the user's photo. Absent, the output follows the
        // input. (num_inference_steps is NOT a real field on this model — it
        // appears only in a hand-written prose snippet on fal's landing page.)
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ProviderError('submit aborted', { code: 'fal_aborted', retryable: false });
    }
    throw new ProviderError('submit failed', { code: 'fal_unavailable', retryable: true });
  }

  if (!out.res.ok) raiseHttp(out.res, out.text, 'fal rejected the generation request');

  const body = parseJson(out.text, 'submit');
  const requestId = body?.request_id;
  if (typeof requestId !== 'string' || !requestId) {
    throw new ProviderError('submit response missing request_id', {
      code: 'fal_unexpected_response', retryable: true,
    });
  }

  // ALWAYS use the URLs fal returns. Do not reconstruct them.
  //
  // Observed against the live API: submitting to
  //   POST queue.fal.run/fal-ai/flux-pro/kontext
  // returns
  //   status_url = queue.fal.run/fal-ai/flux-pro/requests/{id}/status
  // — the trailing `/kontext` is DROPPED, because kontext is a sub-path of the
  // flux-pro app and the queue is keyed on the app, not the endpoint. The
  // obvious reconstruction (`{queueHost}/{model}/requests/{id}`) is therefore
  // wrong for any model with a sub-path, and wrong in the worst way: the poll
  // loop treats 404 as "not visible yet" and would spin until the deadline.
  // If fal ever stops returning these, fail loudly instead of guessing.
  const statusUrl = asAbsolute(body?.status_url);
  const responseUrl = asAbsolute(body?.response_url);
  if (!statusUrl || !responseUrl) {
    throw new ProviderError('submit response missing status_url/response_url', {
      code: 'fal_unexpected_response', retryable: false,
    });
  }
  return { requestId, statusUrl, responseUrl, cancelUrl: asAbsolute(body?.cancel_url) };
}

function asAbsolute(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function numFromEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function pollUntilComplete({ config, submitted, signal, poll }) {
  let waitMs = poll?.initialMs ?? POLL_INITIAL_MS;
  const maxMs = poll?.maxMs ?? POLL_MAX_MS;

  for (;;) {
    if (signal?.aborted) {
      throw new ProviderError('cancelled', { code: 'fal_aborted', retryable: false });
    }

    await sleep(waitMs, signal);
    waitMs = Math.min(Math.round(waitMs * POLL_BACKOFF), maxMs);

    let out;
    try {
      out = await falFetch(submitted.statusUrl, { config, signal, timeoutMs: POLL_TIMEOUT_MS });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ProviderError('cancelled', { code: 'fal_aborted', retryable: false });
      }
      // A single failed poll is not a failed generation — keep waiting; the
      // caller's timeout is the real ceiling.
      continue;
    }

    if (!out.res.ok) {
      // 404 before the request is visible can happen; anything else is real.
      if (out.res.status === 404) continue;
      raiseHttp(out.res, out.text, 'fal status check failed');
    }

    const body = parseJson(out.text, 'status');
    const status = body?.status;

    if (status === 'COMPLETED') {
      // THERE IS NO `FAILED` STATUS. A failed generation completes carrying an
      // error — code that only looks at `status` would treat this as success
      // and then fail confusingly downstream.
      if (body?.error || body?.error_type) {
        const type = String(body?.error_type ?? '').toLowerCase();
        throw new ProviderError('generation failed', {
          code: type === 'content_policy_violation' ? 'content_policy_violation' : 'fal_generation_failed',
          retryable: RETRYABLE_ERROR_TYPES.has(type),
        });
      }
      return;
    }

    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
      throw new ProviderError('unexpected queue status', {
        code: 'fal_unexpected_response', retryable: false,
      });
    }
  }
}

async function fetchResult({ config, submitted, signal }) {
  let out;
  try {
    out = await falFetch(submitted.responseUrl, { config, signal, timeoutMs: POLL_TIMEOUT_MS });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ProviderError('cancelled', { code: 'fal_aborted', retryable: false });
    }
    throw new ProviderError('result fetch failed', { code: 'fal_unavailable', retryable: true });
  }

  if (!out.res.ok) raiseHttp(out.res, out.text, 'fal result fetch failed');

  const body = parseJson(out.text, 'result');
  const first = Array.isArray(body?.images) ? body.images[0] : null;
  const url = first?.url;

  if (typeof url !== 'string' || !url) {
    throw new ProviderError('result missing images[0].url', {
      code: 'fal_unexpected_response', retryable: true,
    });
  }
  // A data URI here means sync_mode leaked back on. Catch it rather than
  // handing a multi-MB string to a caller that expects a URL.
  if (url.startsWith('data:')) {
    throw new ProviderError('result returned a data URI, expected a CDN URL', {
      code: 'fal_unexpected_response', retryable: false,
    });
  }

  // fal's `content_type` is not trustworthy: asking for output_format "png"
  // returns bytes that really are PNG (verified by magic number) alongside
  // `"content_type": "image/jpeg"`. We know what we asked for, so derive the
  // media type from the request and keep fal's value only as a fallback.
  return { url, mediaType: mediaTypeForOutputFormat(OUTPUT_FORMAT) };
}

async function cancel({ config, submitted }) {
  if (!submitted?.cancelUrl) return;
  await fetch(submitted.cancelUrl, {
    method: 'PUT',
    headers: authHeaders(config),
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('cancelled', { code: 'fal_aborted', retryable: false }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled', { code: 'fal_aborted', retryable: false }));
    }, { once: true });
  });
}
