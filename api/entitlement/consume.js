/**
 * POST /api/entitlement/consume
 *
 * Body: { deviceToken }
 *
 * Marks the device's free premium post as used by setting bit0 true.
 *
 * Idempotent: consuming an already-consumed entitlement is a success with the
 * same resulting state, not an error. The bits are read first so the response
 * can report whether this call was the one that consumed it
 * (`alreadyConsumed`), and so an already-set bit costs no write.
 *
 * Privacy: the device token is a device identifier. It is never logged, never
 * written to disk, and never echoed back.
 */

import { send, methodNotAllowed, readJsonBody } from '../../lib/http.js';
import {
  getConfig,
  ConfigError,
  queryTwoBits,
  updateTwoBits,
  validateDeviceTokenBody,
  errorResponse,
} from '../../lib/devicecheck.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
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
    return send(res, 400, {
      error: 'Request body must be valid JSON.',
      code: 'invalid_request',
    });
  }

  const errors = validateDeviceTokenBody(body);
  if (errors.length > 0) {
    return send(res, 400, {
      error: 'Invalid request body.',
      code: 'invalid_request',
      details: errors,
    });
  }

  const deviceToken = body.deviceToken.trim();

  // Read first, so an already-consumed entitlement short-circuits without a
  // write and the caller learns which call actually consumed it.
  const current = await queryTwoBits(config, deviceToken);
  if (current.kind !== 'ok') {
    const [status, payload] = errorResponse(current);
    return send(res, status, payload);
  }

  if (current.bit0 === true) {
    return send(res, 200, {
      freePremiumPostAvailable: false,
      consumed: true,
      alreadyConsumed: true,
      bit0: true,
      bit1: current.bit1,
      lastUpdateTime: current.lastUpdateTime,
      environment: config.environment,
    });
  }

  // Apple has no partial update — bit1 is written explicitly, and stays false
  // while it is reserved.
  const written = await updateTwoBits(config, deviceToken, { bit0: true, bit1: false });
  if (written.kind !== 'ok') {
    const [status, payload] = errorResponse(written);
    return send(res, status, payload);
  }

  return send(res, 200, {
    freePremiumPostAvailable: false,
    consumed: true,
    alreadyConsumed: false,
    bit0: true,
    bit1: false,
    // Apple returns an empty body on update; the resulting state is what we
    // just wrote. lastUpdateTime is only known on a subsequent read.
    lastUpdateTime: null,
    environment: config.environment,
  });
}
