/**
 * Small shared HTTP helpers for the API handlers.
 *
 * (api/curate.js predates this and still carries its own copies; unifying it
 * is a mechanical follow-up, deliberately not bundled into this change.)
 */

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');
  return send(res, 405, {
    error: 'Method not allowed. Use POST.',
    code: 'method_not_allowed',
  });
}

/**
 * Returns the parsed JSON body. Vercel's Node runtime pre-parses
 * application/json into req.body; the stream fallback keeps handlers runnable
 * under a plain node:http server too.
 */
export async function readJsonBody(req) {
  if (isPlainObject(req.body) || Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
  if (req.body != null) return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) throw new Error('empty body');
  return JSON.parse(raw);
}

export const isPlainObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isNonEmptyString = (v) =>
  typeof v === 'string' && v.trim().length > 0;
