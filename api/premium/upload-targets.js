/**
 * POST /api/premium/upload-targets
 *
 * Step 2 of the upload flow. The app asks for N signed upload targets; this
 * server calls fal with FAL_KEY and hands back only the signed URLs. The app
 * then PUTs photo bytes straight to fal.
 *
 *   app -> here            "I have 7 photos, these content types"
 *   here -> fal            POST /storage/upload/initiate  (x7, with our key)
 *   here -> app            [{ uploadUrl, fileUrl }, ...]
 *   app  -> fal CDN        PUT bytes to uploadUrl        (no key involved)
 *   app  -> here           POST /api/premium/generate with the fileUrls
 *
 * PHOTO BYTES NEVER TOUCH THIS SERVER, which is forced by Vercel's 4.5 MB cap
 * on both request and response bodies, and FAL_KEY never reaches the app,
 * which is forced by an IPA being unpackable.
 *
 * WHY THIS IS GATED ON A DEVICE TOKEN. An open endpoint that mints upload URLs
 * against our paid fal account is free file hosting for anyone who finds it.
 * The token is verified with Apple — forged tokens are rejected — but the
 * entitlement BIT is deliberately not checked: uploading happens before
 * generation, and a future paying user will have bit0 already set. This proves
 * "a real Apple device asked", not "this device is entitled". /api/premium/
 * generate remains the place entitlement is enforced.
 *
 * Privacy: the device token, file names, and URLs are never logged.
 */

import { send, methodNotAllowed, readJsonBody, isPlainObject, isNonEmptyString } from '../../lib/http.js';
import {
  getConfig as getDeviceConfig,
  ConfigError,
  queryTwoBits,
  validateDeviceTokenBody,
  errorResponse as deviceErrorResponse,
} from '../../lib/devicecheck.js';
import { getFalConfig } from '../../lib/fal.js';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  createUploadTargets,
  extensionForContentType,
} from '../../lib/falStorage.js';
import { ProviderError, ProviderConfigError } from '../../lib/providerErrors.js';

/** Matches /api/premium/generate's MAX_PHOTOS — the same batch, one step earlier. */
export const MAX_UPLOAD_TARGETS = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let deviceConfig;
  let falConfig;
  try {
    deviceConfig = getDeviceConfig();
    falConfig = getFalConfig();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ProviderConfigError) {
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
    return send(res, 400, { error: 'Request body must be valid JSON.', code: 'invalid_request' });
  }

  const errors = validateRequest(body);
  if (errors.length > 0) {
    return send(res, 400, { error: 'Invalid request body.', code: 'invalid_request', details: errors });
  }

  // Proves a real Apple device is asking. Not an entitlement check — see above.
  const device = await queryTwoBits(deviceConfig, body.deviceToken.trim());
  if (device.kind !== 'ok') {
    const [status, payload] = deviceErrorResponse(device);
    return send(res, status, payload);
  }

  const files = normalizeFiles(body.files);

  let targets;
  try {
    targets = await createUploadTargets(files, { config: falConfig });
  } catch (err) {
    if (err instanceof ProviderError) {
      const status = err.code === 'fal_auth_failed' ? 500
        : err.code === 'fal_rate_limited' ? 429
        : 502;
      return send(res, status, {
        error: err.code === 'fal_auth_failed'
          ? 'Server misconfigured: fal rejected the server credentials.'
          : 'Could not create upload targets.',
        code: err.code === 'fal_auth_failed' ? 'server_misconfigured' : err.code,
      });
    }
    throw err;
  }

  // Count only — no URLs, no file names, no device token.
  console.log('[upload-targets] minted=%d', targets.length);

  return send(res, 200, {
    targets: targets.map((t, i) => ({
      uploadUrl: t.uploadUrl,
      fileUrl: t.fileUrl,
      // Spelled out so the Swift side does not have to infer the protocol.
      method: 'PUT',
      headers: { 'Content-Type': files[i].contentType },
      contentType: files[i].contentType,
    })),
    // fal does not document how long a signed upload URL stays valid, so this
    // is not a promise — treat targets as short-lived and upload promptly.
    expiresInSeconds: null,
    objectExpirySeconds: falConfig.expirySeconds || null,
  });
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Paths and shapes only — never values. File names are user data. */
export function validateRequest(body) {
  const errors = [];
  if (!isPlainObject(body)) return ['body must be a JSON object'];

  errors.push(...validateDeviceTokenBody(body));

  if (!Array.isArray(body.files)) {
    errors.push('files must be an array');
    return errors;
  }
  if (body.files.length === 0) {
    errors.push('files must not be empty');
    return errors;
  }
  if (body.files.length > MAX_UPLOAD_TARGETS) {
    errors.push(`files must contain at most ${MAX_UPLOAD_TARGETS} entries; got ${body.files.length}`);
    return errors;
  }

  body.files.forEach((file, i) => {
    const at = `files[${i}]`;
    if (!isPlainObject(file)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(file.contentType)) {
      errors.push(`${at}.contentType must be a non-empty string`);
    } else if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(file.contentType.trim().toLowerCase())) {
      errors.push(
        `${at}.contentType must be one of: ${[...ALLOWED_UPLOAD_CONTENT_TYPES].join(', ')}`
      );
    }
    if (file.fileName !== undefined && !isNonEmptyString(file.fileName)) {
      errors.push(`${at}.fileName must be a non-empty string when present`);
    }
  });

  return errors;
}

/**
 * A client-supplied file name reaches a third party and ends up in a URL path,
 * so it is reduced to a safe stem plus an extension derived from the content
 * type. Anything unusable becomes a generated name.
 */
function normalizeFiles(files) {
  return files.map((f, i) => {
    const contentType = f.contentType.trim().toLowerCase();
    const ext = extensionForContentType(contentType);
    const stem = isNonEmptyString(f.fileName)
      ? f.fileName.trim().replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '')
      : '';
    return {
      contentType,
      fileName: `${stem || `photo-${i + 1}`}.${ext}`,
    };
  });
}
