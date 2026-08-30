import { ProviderError, ProviderConfigError, ProviderTimeoutError } from './providerErrors.js';
import { falProvider } from './falProvider.js';

/**
 * The image-generation provider boundary.
 *
 * ONE function matters to the rest of the codebase: `generate()`. Give it an
 * image and a style instruction, get an edited image back. Nothing outside
 * this module knows or cares which service is behind it — swapping providers
 * is an env var change (`IMAGE_PROVIDER`), not a code change.
 *
 * TWO IMPLEMENTATIONS. `fal` (lib/falProvider.js) runs fal-ai/flux-pro/kontext
 * for real; `stub` returns its input unchanged. The stub is NOT a placeholder
 * to be deleted — it is the offline/CI implementation, and the reason the
 * whole premium pipeline stays exercisable without spending money.
 * IMAGE_PROVIDER selects between them; it defaults to `stub` so nothing spends
 * by accident.
 *
 * FULL RESOLUTION, ALWAYS. Generation is non-deterministic: the same photo and
 * instruction produce a different image every call. So the image the user
 * approves in the preview MUST be the exact image that exports — generating a
 * small preview and regenerating at full res for export would hand them
 * something they never saw. The app downsamples for preview; this layer only
 * ever deals in the full-resolution asset. (BUILD_ROADMAP Phase 3.5's
 * generate-at-full-resolution note; Phase 6's preview-matches-export-1:1
 * acceptance criterion.)
 *
 * IMAGES MOVE BY REFERENCE, NOT BY VALUE. `image` is a { url, mediaType },
 * and a result is either another URL or raw bytes. This is forced by the
 * platform, not a preference: Vercel caps a function's request AND response
 * body at 4.5 MB, which a single full-res photo can approach and 21 generated
 * ones blow past by an order of magnitude. See README's "Premium tier" section
 * for the blob-store decision this leaves open.
 *
 * Privacy invariants (unchanged from the rest of the repo):
 *   - image bytes and URLs are never logged and never written to disk
 *   - provider credentials are read from the environment only; never logged,
 *     never included in a response
 *   - a provider's raw error text is mapped to our own codes, never forwarded
 */

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Defined in lib/providerErrors.js and re-exported here so a concrete provider
 * can throw them without importing this module, which imports the provider.
 * Every existing `from './imageProvider.js'` import keeps working.
 */
export { ProviderError, ProviderTimeoutError, ProviderConfigError } from './providerErrors.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_PROVIDER = 'stub';

// Deliberately conservative. Every provider caps simultaneous requests and the
// cap varies by service and by account tier, so this is read from the
// environment rather than hardcoded — see README's "Premium tier" section for
// why a low real-world cap is the single biggest risk to this design.
export const DEFAULT_CONCURRENCY = 3;

// Per-call ceiling. Generation is slow (single-digit to tens of seconds is
// normal), so this is generous — but it must stay well under the function's
// own 300s budget or a single hung call eats the entire batch's runway.
export const DEFAULT_TIMEOUT_MS = 90_000;

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 280_000;

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim().length === 0) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) {
    throw new ProviderConfigError(`${name} must be an integer (got "${raw}")`);
  }
  if (n < min || n > max) {
    throw new ProviderConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
  }
  return n;
}

/**
 * Reads provider selection and tuning from the environment. Throws
 * ProviderConfigError with a message safe to surface — it never contains a
 * credential, only the name of the variable and the out-of-range value.
 */
export function getProviderConfig(env = process.env) {
  const name = (env.IMAGE_PROVIDER ?? DEFAULT_PROVIDER).trim().toLowerCase();
  if (!Object.hasOwn(PROVIDERS, name)) {
    throw new ProviderConfigError(
      `IMAGE_PROVIDER must be one of: ${Object.keys(PROVIDERS).join(', ')} (got "${name}")`
    );
  }
  return {
    name,
    concurrency: readInt(env, 'IMAGE_PROVIDER_CONCURRENCY', DEFAULT_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY),
    timeoutMs: readInt(env, 'IMAGE_PROVIDER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}

/* ------------------------------------------------------------------ */
/* The stub provider                                                   */
/* ------------------------------------------------------------------ */

/**
 * Returns the input image unchanged.
 *
 * This exists so the batch endpoint, the wave scheduler, the retry/fallback
 * policy, the progress stream, and the app's own wiring are all testable
 * before a provider is chosen and without spending a cent. It is NOT a
 * placeholder to be deleted — it stays as the offline/CI implementation.
 *
 * Two env knobs, stub-only, for exercising paths that are otherwise hard to
 * reach deliberately:
 *   IMAGE_PROVIDER_STUB_DELAY_MS   — fake per-call latency, so wave pacing and
 *                                    progress events can be watched in real time
 *   IMAGE_PROVIDER_STUB_FAIL_RATE  — 0..1, fraction of calls that throw, so the
 *                                    retry-then-fall-back path can be forced
 */
const stubProvider = {
  name: 'stub',
  async generate({ image, signal }, env = process.env) {
    const delayMs = Number(env.IMAGE_PROVIDER_STUB_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }

    const failRate = Number(env.IMAGE_PROVIDER_STUB_FAIL_RATE ?? 0);
    if (Number.isFinite(failRate) && failRate > 0 && Math.random() < failRate) {
      throw new ProviderError('stub: synthetic failure', {
        code: 'stub_synthetic_failure',
        retryable: true,
      });
    }

    // Unchanged: the same asset, described the same way. Because it hands back
    // the input URL rather than bytes, the whole pipeline runs with no blob
    // store configured — which is exactly what makes it useful for testing.
    return { url: image.url, mediaType: image.mediaType ?? null };
  },
};

/**
 * The registry. Adding a real provider is one entry here plus its own module;
 * nothing else in the codebase changes.
 *
 * A real implementation must:
 *   - honour `signal` (the caller enforces the timeout by aborting it)
 *   - throw ProviderError with retryable:false for failures a second attempt
 *     cannot fix (rejected content, unsupported format, bad credentials)
 *   - return { url, mediaType } or { bytes, mediaType } at FULL resolution
 *   - never log the image, its URL, or its bytes
 */
export const PROVIDERS = {
  stub: stubProvider,
  fal: falProvider,
};

/**
 * Validates the selected provider's own credentials, if it has any. Called at
 * pre-flight so a misconfigured provider is a 500 before anything is spent,
 * rather than a stream of fallbacks. Providers without credentials (the stub)
 * simply have no validateConfig.
 *
 * @throws {ProviderConfigError}
 */
export function validateProviderCredentials(env = process.env) {
  const { name } = getProviderConfig(env);
  const impl = getProvider(name);
  if (typeof impl.validateConfig === 'function') impl.validateConfig(env);
}

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new ProviderConfigError(`unknown image provider "${name}"`);
  }
  return provider;
}

/* ------------------------------------------------------------------ */
/* The one call                                                        */
/* ------------------------------------------------------------------ */

/**
 * Runs one generation with a hard per-call timeout.
 *
 * @param {object}  args
 * @param {object}  args.image        { url, mediaType } — full-resolution source
 * @param {string}  args.instruction  the style instruction for this variant
 * @param {object}  [args.provider]   defaults to the configured one
 * @param {number}  [args.timeoutMs]  defaults to the configured value
 * @param {AbortSignal} [args.signal] caller's own cancellation (batch-wide)
 * @returns {Promise<{url?: string, bytes?: Buffer, mediaType: string|null}>}
 * @throws {ProviderTimeoutError} on timeout, distinguishable from ProviderError
 */
export async function generate({ image, instruction, provider, timeoutMs, signal, env = process.env }) {
  const config = getProviderConfig(env);
  const impl = provider ?? getProvider(config.name);
  const limitMs = timeoutMs ?? config.timeoutMs;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let timedOut = false;
  let timer;
  // The timeout is RACED, not merely signalled. Aborting `controller` asks a
  // well-behaved provider to stop, but a provider that ignores its signal — or
  // a socket that hangs without erroring — would otherwise leave this awaiting
  // forever, blowing past the per-call limit and eating the whole batch's
  // 300s budget. Racing makes the ceiling hold regardless of what the provider
  // does with the signal. (Found by a test using a never-settling promise; the
  // await-only version hung indefinitely.)
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProviderTimeoutError(limitMs));
    }, limitMs);
  });

  try {
    return await Promise.race([
      impl.generate({ image, instruction, signal: controller.signal }, env),
      timeout,
    ]);
  } catch (err) {
    // The timeout wins over whatever the abort surfaced as inside the provider,
    // so the batch layer can always tell "too slow" from "actually broken".
    if (timedOut) throw new ProviderTimeoutError(limitMs);
    if (err instanceof ProviderError) throw err;
    // Never surface a provider's raw message — it can quote request content.
    throw new ProviderError('generation failed', { code: 'provider_error' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
