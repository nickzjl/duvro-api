/**
 * POST /api/premium/generate
 *
 * The premium tier's batch: for each chosen photo, generate one image per
 * variant in the pack — three per photo, replacing the free tier's local Core
 * Image renders. The app then picks between them in the existing three-way
 * edit screen, unchanged.
 *
 * RESPONDS AS AN NDJSON STREAM, not a single JSON body. 21 generations is a
 * long wait and the app needs something to show; each completed slot is
 * written as its own line the moment it lands. See README's "Premium tier"
 * section for why streaming rather than polling.
 *
 * ORDER MATTERS HERE: every rejection — bad body, unknown pack, over the cap,
 * no entitlement — happens BEFORE the first byte is written. Once a single
 * byte goes out the status code is committed to 200 and cannot be changed, so
 * anything that should be a 4xx has to be decided first. That is also exactly
 * the property the spec asks for: "a request without a valid entitlement gets
 * rejected before anything is spent."
 *
 * Privacy invariants (unchanged):
 *   - image URLs and image data are never logged and never written to disk
 *   - the device token is a device identifier: never logged, never echoed
 *   - only numeric counters are logged, for cost visibility
 */

import { send, methodNotAllowed, readJsonBody, isPlainObject, isNonEmptyString } from '../../lib/http.js';
import {
  getConfig,
  ConfigError,
  queryTwoBits,
  validateDeviceTokenBody,
  errorResponse,
} from '../../lib/devicecheck.js';
import { PACK_VARIANTS, canonicalVariant } from '../../lib/styles.js';
import { runBatch } from '../../lib/premiumBatch.js';
import { ProviderConfigError, getProviderConfig } from '../../lib/imageProvider.js';

/**
 * Hard caps, so a malformed or hostile request cannot fire hundreds of
 * generations. 10 photos is the carousel ceiling the curation endpoint
 * already enforces, so this cannot legitimately be exceeded by the real app.
 */
export const MAX_PHOTOS = 10;
export const MAX_GENERATIONS = MAX_PHOTOS * 3;

/**
 * The batch's own budget, comfortably inside the function's maxDuration (300s,
 * set in vercel.json — Hobby's hard maximum). The margin is what pays for
 * flushing the final response after the last generation returns; without it a
 * batch that used the full 300s would be killed while writing its own results.
 */
const FUNCTION_MAX_DURATION_MS = 300_000;
const RESPONSE_MARGIN_MS = 20_000;
const BATCH_BUDGET_MS = FUNCTION_MAX_DURATION_MS - RESPONSE_MARGIN_MS;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  /* -------------------------------------------------------------- */
  /* Everything below happens before the first byte is written.      */
  /* -------------------------------------------------------------- */

  let deviceConfig;
  try {
    deviceConfig = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      return send(res, 500, {
        error: `Server misconfigured: ${err.message}`,
        code: 'server_misconfigured',
      });
    }
    throw err;
  }

  // Fail fast on provider misconfiguration too — discovering IMAGE_PROVIDER is
  // unset after burning an entitlement would be the worst possible ordering.
  let providerConfig;
  try {
    providerConfig = getProviderConfig();
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return send(res, 500, {
        error: `Server misconfigured: ${err.message}`,
        code: 'server_misconfigured',
      });
    }
    throw err;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    // No detail: a parse error message can quote the body, which holds the token.
    return send(res, 400, { error: 'Request body must be valid JSON.', code: 'invalid_request' });
  }

  const errors = validateRequest(body);
  if (errors.length > 0) {
    return send(res, 400, {
      error: 'Invalid request body.',
      code: 'invalid_request',
      details: errors,
    });
  }

  // Entitlement, last of the pre-flight checks and the one that costs a round
  // trip. Read-only: consuming stays an explicit, separate call to
  // /api/entitlement/consume, so an abandoned or failed batch does not silently
  // burn the user's one free post.
  const entitlement = await queryTwoBits(deviceConfig, body.deviceToken.trim());
  if (entitlement.kind !== 'ok') {
    const [status, payload] = errorResponse(entitlement);
    return send(res, status, payload);
  }
  if (entitlement.bit0 === true) {
    // The free post is spent. Paid entitlement (receipt validation) is not
    // built yet — see README's "Premium tier" section.
    return send(res, 402, {
      error: 'This device has already used its free premium post.',
      code: 'entitlement_required',
      freePremiumPostAvailable: false,
    });
  }

  const variants = PACK_VARIANTS[body.vibePack];
  const photos = body.photos.map((p) => ({
    id: p.id,
    url: p.url,
    mediaType: isNonEmptyString(p.mediaType) ? p.mediaType.trim() : null,
  }));

  /* -------------------------------------------------------------- */
  /* Committed to 200 from here on.                                  */
  /* -------------------------------------------------------------- */

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // Hint to any intermediary not to buffer; harmless where it means nothing.
  res.setHeader('X-Accel-Buffering', 'no');

  const writeLine = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
    // Flush eagerly where the runtime exposes it — a buffered "stream" would
    // deliver every line at the end, which is the same as not streaming.
    if (typeof res.flush === 'function') res.flush();
  };

  // If the client hangs up, stop paying for generations nobody will receive.
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on?.('close', onClose);

  let result;
  try {
    result = await runBatch({
      photos,
      vibePack: body.vibePack,
      variants,
      deadlineAt: Date.now() + BATCH_BUDGET_MS,
      onProgress: writeLine,
      signal: controller.signal,
    });
  } catch (err) {
    // The batch itself does not throw for generation failures — those become
    // fallbacks. Reaching here means something structural (a missing style
    // file, say). The status is already 200, so this has to be an event.
    writeLine({
      type: 'error',
      code: 'batch_failed',
      error: 'The batch could not be run. Render all variants locally.',
    });
    res.off?.('close', onClose);
    return res.end();
  }

  // Numeric only — no photo ids, no URLs, no image data. This is the cost
  // record: what was attempted, what succeeded, what fell back and why.
  console.log(
    '[premium] provider=%s photos=%d slots=%d attempted=%d retried=%d generated=%d fellBack=%d reasons=%s',
    providerConfig.name,
    photos.length,
    result.counts.totalSlots,
    result.counts.attempted,
    result.counts.retried,
    result.counts.generated,
    result.counts.fellBack,
    JSON.stringify(result.counts.byReason),
  );

  // The terminal line repeats every slot, so a client that missed or ignored
  // the incremental events still has the complete result from this one object.
  writeLine({ type: 'complete', counts: result.counts, slots: result.slots });

  res.off?.('close', onClose);
  return res.end();
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Messages name field PATHS and shapes only — never values. A photo URL is
 * user data and the device token is a device identifier; neither may appear
 * in an error body.
 */
export function validateRequest(body) {
  const errors = [];

  if (!isPlainObject(body)) return ['body must be a JSON object'];

  errors.push(...validateDeviceTokenBody(body));

  if (!Object.hasOwn(PACK_VARIANTS, body.vibePack)) {
    errors.push(`vibePack must be one of: ${Object.keys(PACK_VARIANTS).join(', ')}`);
  }

  if (!Array.isArray(body.photos)) {
    errors.push('photos must be an array');
  } else if (body.photos.length === 0) {
    errors.push('photos must not be empty');
  } else if (body.photos.length > MAX_PHOTOS) {
    // The hard cap. 3 generations per photo, so this bounds spend per request.
    errors.push(
      `photos must contain at most ${MAX_PHOTOS} entries ` +
      `(${MAX_GENERATIONS} generations); got ${body.photos.length}`
    );
  } else {
    const seen = new Set();
    body.photos.forEach((photo, i) => {
      const at = `photos[${i}]`;
      if (!isPlainObject(photo)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isNonEmptyString(photo.id)) {
        errors.push(`${at}.id must be a non-empty string`);
      } else if (seen.has(photo.id)) {
        errors.push(`${at}.id is a duplicate of an earlier photo id`);
      } else {
        seen.add(photo.id);
      }

      const urlError = validateImageUrl(photo.url);
      if (urlError) errors.push(`${at}.url ${urlError}`);

      if (photo.mediaType !== undefined && !isNonEmptyString(photo.mediaType)) {
        errors.push(`${at}.mediaType must be a non-empty string when present`);
      }
    });
  }

  // Belt and braces: even a well-formed request must not exceed the cap once
  // multiplied out, in case variants-per-pack ever stops being three.
  if (Array.isArray(body.photos) && Object.hasOwn(PACK_VARIANTS, body.vibePack)) {
    const total = body.photos.length * PACK_VARIANTS[body.vibePack].length;
    if (total > MAX_GENERATIONS) {
      errors.push(`request would require ${total} generations; the maximum is ${MAX_GENERATIONS}`);
    }
  }

  return errors;
}

/**
 * Images arrive as URLs rather than bytes because Vercel caps a function's
 * request body at 4.5 MB — a single full-resolution photo can approach that
 * and seven cannot fit. Those URLs are then handed to a provider, which will
 * fetch them, so they are validated as a server-side-request target and not
 * merely as strings: https only, and no hostname that resolves to somewhere
 * only this server can reach.
 *
 * Returns null when valid, or a message describing the problem WITHOUT
 * quoting the URL.
 */
export function validateImageUrl(value) {
  if (!isNonEmptyString(value)) return 'must be a non-empty string';

  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return 'must be a valid absolute URL';
  }

  if (url.protocol !== 'https:') return 'must use https';

  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||               // link-local, incl. cloud metadata
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)   // 172.16.0.0/12
  ) {
    return 'must not point at a private or loopback address';
  }

  // Optional allowlist, for once images live in a known bucket. Unset means
  // any public https host is accepted.
  const allowed = (process.env.PREMIUM_ALLOWED_IMAGE_HOSTS ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length > 0 && !allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    return 'host is not in PREMIUM_ALLOWED_IMAGE_HOSTS';
  }

  return null;
}
