/**
 * POST /api/entitlement/check
 *
 * Body: { deviceToken }
 *
 * Asks Apple for the device's two DeviceCheck bits and reports whether the
 * one free premium post is still available. Read-only — it never writes bits.
 *
 * Privacy: the device token is a device identifier. It is never logged, never
 * written to disk, and never echoed back.
 */

import { send, methodNotAllowed, readJsonBody } from '../../lib/http.js';
import {
  getConfig,
  ConfigError,
  queryTwoBits,
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

  const result = await queryTwoBits(config, body.deviceToken.trim());
  if (result.kind !== 'ok') {
    const [status, payload] = errorResponse(result);
    return send(res, status, payload);
  }

  return send(res, 200, {
    freePremiumPostAvailable: result.bit0 !== true,
    consumed: result.bit0 === true,
    bit0: result.bit0,
    bit1: result.bit1,
    lastUpdateTime: result.lastUpdateTime,
    environment: config.environment,
  });
}
