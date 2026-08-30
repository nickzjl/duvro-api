/**
 * Shared fal.ai client concerns: configuration, auth, error classification.
 *
 * Used by both lib/falStorage.js (minting upload targets) and
 * lib/falProvider.js (running generations).
 *
 * AUTH IS `Key`, NOT `Bearer`. Verified against fal's docs and the official
 * client's own source (`Authorization: Key ${credentials}` in
 * @fal-ai/client's request.js). `Bearer` appears in fal's docs only for the
 * MCP server and for CDN reads of ACL-restricted files — never for the REST
 * or inference APIs this module calls.
 *
 * Privacy invariants:
 *   - FAL_KEY is read from the environment only; never logged, never returned
 *   - image URLs and bytes are never logged
 *   - fal's raw error text is mapped to our own codes, never forwarded
 */

import { ProviderConfigError } from './providerErrors.js';

/** Hosts are overridable so a fal-side change needs an env edit, not a deploy. */
export const DEFAULT_QUEUE_HOST = 'https://queue.fal.run';
export const DEFAULT_REST_HOST = 'https://rest.fal.ai';
export const DEFAULT_MODEL = 'fal-ai/flux-pro/kontext';

/**
 * How long uploaded photos and generated images live on fal's CDN.
 *
 * fal's default is "no expiration" — user photos would sit on a third party's
 * CDN indefinitely, which sits badly with a product whose pitch is that
 * nothing is retained. 24h is far longer than a batch needs and short enough
 * that an abandoned session cleans itself up. Set to 0 to opt out.
 */
export const DEFAULT_OBJECT_EXPIRY_SECONDS = 86_400;

const MAX_EXPIRY_SECONDS = 31_536_000; // one year

export function getFalConfig(env = process.env) {
  const key = env.FAL_KEY;
  if (!key || String(key).trim().length === 0) {
    throw new ProviderConfigError('missing environment variable: FAL_KEY');
  }

  const rawExpiry = env.FAL_OBJECT_EXPIRY_SECONDS;
  let expirySeconds = DEFAULT_OBJECT_EXPIRY_SECONDS;
  if (rawExpiry !== undefined && String(rawExpiry).trim().length > 0) {
    const n = Number(String(rawExpiry).trim());
    if (!Number.isInteger(n) || n < 0 || n > MAX_EXPIRY_SECONDS) {
      throw new ProviderConfigError(
        `FAL_OBJECT_EXPIRY_SECONDS must be an integer between 0 and ${MAX_EXPIRY_SECONDS} (got "${rawExpiry}")`
      );
    }
    expirySeconds = n;
  }

  return {
    key: String(key).trim(),
    model: (env.FAL_MODEL ?? DEFAULT_MODEL).trim(),
    queueHost: stripTrailingSlash(env.FAL_QUEUE_HOST ?? DEFAULT_QUEUE_HOST),
    restHost: stripTrailingSlash(env.FAL_REST_HOST ?? DEFAULT_REST_HOST),
    expirySeconds,
  };
}

const stripTrailingSlash = (s) => String(s).trim().replace(/\/+$/, '');

/** `Key <token>`, per fal's docs and their client's source. Never `Bearer`. */
export function authHeaders(config) {
  return {
    authorization: `Key ${config.key}`,
    accept: 'application/json',
  };
}

/**
 * Object-lifecycle headers. fal uses two DIFFERENT header names for the two
 * cases, which is easy to get wrong:
 *   - uploads          -> X-Fal-Object-Lifecycle
 *   - queue/run output -> X-Fal-Object-Lifecycle-Preference
 * Both carry the same JSON body. Returns {} when expiry is disabled.
 */
export function uploadLifecycleHeaders(config) {
  if (!config.expirySeconds) return {};
  return {
    'x-fal-object-lifecycle': JSON.stringify({ expiration_duration_seconds: config.expirySeconds }),
  };
}

export function outputLifecycleHeaders(config) {
  if (!config.expirySeconds) return {};
  return {
    'x-fal-object-lifecycle-preference': JSON.stringify({
      expiration_duration_seconds: config.expirySeconds,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/**
 * fal returns two different error shapes:
 *   - model/validation errors: { detail: [ { type, msg, loc, ... } ] }   (422)
 *   - request/infra errors:    { detail: "...", error_type: "..." }
 * plus an `X-Fal-Error-Type` header mirroring the latter, and an
 * `X-Fal-Needs-Retry` header on failures fal considers worth retrying.
 *
 * Returns { code, retryable, status } — never fal's own message, which can
 * quote request content.
 */
export function classifyFalError(status, headers, bodyText) {
  const header = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  };

  // fal's own retry advice wins when present — it knows better than a status map.
  const needsRetry = header('x-fal-needs-retry');
  const falSaysRetry = needsRetry != null && String(needsRetry).trim() !== ''
    && String(needsRetry).trim() !== '0' && String(needsRetry).trim().toLowerCase() !== 'false';

  let errorType = header('x-fal-error-type');
  if (!errorType && bodyText) {
    try {
      const body = JSON.parse(bodyText);
      if (typeof body?.error_type === 'string') {
        errorType = body.error_type;
      } else if (Array.isArray(body?.detail) && typeof body.detail[0]?.type === 'string') {
        errorType = body.detail[0].type;
      }
    } catch {
      /* not JSON — fall through to the status map */
    }
  }
  const type = errorType ? String(errorType).toLowerCase() : null;

  // Content policy is the one failure a user can actually act on, so it keeps
  // its own code all the way out to the app.
  if (type === 'content_policy_violation') {
    return { code: 'content_policy_violation', retryable: false, status };
  }
  if (type === 'concurrent_requests_limit' || status === 429) {
    return { code: 'fal_rate_limited', retryable: true, status };
  }

  if (status === 401 || status === 403) {
    // Our key, not the user's request. A retry cannot fix it.
    return { code: 'fal_auth_failed', retryable: false, status };
  }
  if (status === 422) {
    // Validation and content errors. fal documents unknown 422 types as
    // non-retryable by default, so that is what we do.
    return { code: 'fal_rejected_request', retryable: false, status };
  }
  if (status === 400) {
    return { code: 'fal_rejected_request', retryable: falSaysRetry, status };
  }
  if (status === 404) {
    return { code: 'fal_not_found', retryable: false, status };
  }
  if (status >= 500 || falSaysRetry) {
    return { code: 'fal_unavailable', retryable: true, status };
  }

  return { code: 'fal_error', retryable: falSaysRetry, status };
}
