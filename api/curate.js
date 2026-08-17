/**
 * POST /api/curate
 *
 * Skeleton only. No Claude API call yet — this validates the payload shape,
 * confirms the ANTHROPIC_API_KEY env var is wired, and returns a hardcoded
 * selection derived from the request.
 *
 * Privacy invariants (duvro promises nothing is retained server-side):
 *   - the request body is never logged, echoed, or written to disk
 *   - ANTHROPIC_API_KEY is read from the environment only; never logged,
 *     never included in a response, never persisted
 *   - validation errors reference field *paths*, never field *values*
 */

const MAX_PHOTOS = 500;
const MAX_ERRORS = 20;
const RUNNER_UP_COUNT = 3;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  // Fail loudly if the key isn't wired, even though nothing calls the API yet.
  // Presence check only — the value is never read into a response or a log.
  if (!process.env.ANTHROPIC_API_KEY) {
    return send(res, 500, { error: 'Server misconfigured: ANTHROPIC_API_KEY is not set.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    // Deliberately no detail: a parse error message can quote the body.
    return send(res, 400, { error: 'Request body must be valid JSON.' });
  }

  const errors = validate(body);
  if (errors.length > 0) {
    return send(res, 400, {
      error: 'Invalid request body.',
      details: errors.slice(0, MAX_ERRORS),
    });
  }

  const ids = body.photos.map((p) => p.id);

  // --- Hardcoded stub response ---------------------------------------------
  // Replace this block with the Claude call. Shape stays the same.
  const selection = ids.slice(0, body.count);
  const runnerUps = ids.slice(body.count, body.count + RUNNER_UP_COUNT);

  return send(res, 200, {
    selection,
    runnerUps,
    vibePack: body.vibePack,
    stub: true,
  });
}

/**
 * Validates the payload shape. Returns an array of human-readable messages
 * that name field paths only — never values, which are user photo data.
 */
function validate(body) {
  const errors = [];

  if (!isPlainObject(body)) {
    return ['body must be a JSON object'];
  }

  // --- photos ---
  if (!Array.isArray(body.photos)) {
    errors.push('photos must be an array');
  } else if (body.photos.length === 0) {
    errors.push('photos must not be empty');
  } else if (body.photos.length > MAX_PHOTOS) {
    errors.push(`photos must contain at most ${MAX_PHOTOS} entries`);
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

      // Content is not inspected — only that a thumbnail is present.
      if (!isNonEmptyString(photo.thumbnail)) {
        errors.push(`${at}.thumbnail must be a non-empty base64 string`);
      }

      if (!isPlainObject(photo.metrics)) {
        errors.push(`${at}.metrics must be an object`);
        return;
      }

      const m = photo.metrics;

      if (!isNonEmptyString(m.category)) {
        errors.push(`${at}.metrics.category must be a non-empty string`);
      }
      if (!isNonNegativeInteger(m.faceCount)) {
        errors.push(`${at}.metrics.faceCount must be an integer >= 0`);
      }
      if (!isFiniteNumber(m.faceQuality)) {
        errors.push(`${at}.metrics.faceQuality must be a number`);
      }
      if (!isNonEmptyString(m.clusterID) && !isFiniteNumber(m.clusterID)) {
        errors.push(`${at}.metrics.clusterID must be a string or a number`);
      }
      if (!isNonEmptyString(m.timestamp) && !isFiniteNumber(m.timestamp)) {
        errors.push(
          `${at}.metrics.timestamp must be an ISO 8601 string or a numeric epoch`
        );
      }
    });
  }

  // --- count ---
  if (!isPositiveInteger(body.count)) {
    errors.push('count must be an integer >= 1');
  } else if (Array.isArray(body.photos) && body.photos.length > 0 && body.count > body.photos.length) {
    errors.push('count must not exceed the number of photos provided');
  }

  // --- vibePack ---
  if (!isNonEmptyString(body.vibePack)) {
    errors.push('vibePack must be a non-empty string');
  }

  return errors;
}

/**
 * Returns the parsed JSON body. Vercel's Node runtime pre-parses
 * application/json into req.body; the stream fallback keeps this handler
 * runnable under a plain node:http server too.
 */
async function readJsonBody(req) {
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

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;
const isPositiveInteger = (v) => Number.isInteger(v) && v >= 1;
