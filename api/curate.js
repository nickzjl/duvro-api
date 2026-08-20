/**
 * POST /api/curate
 *
 * Validates a camera-roll payload, calls Claude with the system prompt for the
 * requested (vibePack, tier) pair, validates the model's JSON against the
 * schema the prompts specify, and returns it.
 *
 * Privacy invariants (duvro promises nothing is retained server-side):
 *   - the request body is never logged, echoed, or written to disk
 *   - the model's response is never logged either (it describes user photos)
 *   - ANTHROPIC_API_KEY is read from the environment only; never logged,
 *     never written to a file, never included in a response
 *   - validation errors reference field *paths*, never field *values*
 */

import { loadSystemPrompt, VIBE_PACKS, TIERS } from '../lib/prompts.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';

// Sized for the worst realistic response: 10 carousel entries with
// selectionReason, 5 alternates with reason, 5 captions. See README.
const MAX_TOKENS = 8192;

// The Anthropic API accepts at most 100 images per request.
const MAX_PHOTOS = 100;

// Below the 300s Vercel ceiling so we return a JSON error rather than a
// platform 504 HTML page.
const UPSTREAM_TIMEOUT_MS = 240_000;

const MAX_ERRORS = 20;
const MAX_CAROUSEL = 10;
const MAX_ALTERNATES = 5;
const MAX_CAPTIONS = 5;

const POST_CONCEPTS = new Set(['cohesive_event', 'life_lately']);
const ROLES = new Set([
  'hero', 'portrait', 'outfit', 'candid', 'social',
  'place', 'food', 'detail', 'atmosphere',
]);
const ALTERNATE_TYPES = new Set(['swap', 'extension']);

const SUPPORTED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, {
      error: 'Method not allowed. Use POST.',
      code: 'method_not_allowed',
    });
  }

  // Presence check only — the value is never read into a response or a log.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return send(res, 500, {
      error: 'Server misconfigured: ANTHROPIC_API_KEY is not set.',
      code: 'server_misconfigured',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    // Deliberately no detail: a parse error message can quote the body.
    return send(res, 400, {
      error: 'Request body must be valid JSON.',
      code: 'invalid_request',
    });
  }

  const errors = validateRequest(body);
  if (errors.length > 0) {
    return send(res, 400, {
      error: 'Invalid request body.',
      code: 'invalid_request',
      details: errors.slice(0, MAX_ERRORS),
    });
  }

  const systemPrompt = loadSystemPrompt(body.vibePack, body.tier);
  const knownIds = new Set(body.photos.map((p) => p.id));

  let upstream;
  try {
    upstream = await callAnthropic({ apiKey, systemPrompt, photos: body.photos });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'upstream_timeout') {
      return send(res, 504, {
        error: 'Curation timed out upstream. Fall back to on-device selection.',
        code: 'upstream_timeout',
      });
    }
    return send(res, 502, {
      error: 'Curation service unavailable. Fall back to on-device selection.',
      code: 'upstream_error',
      upstreamStatus: err?.upstreamStatus ?? null,
    });
  }

  if (upstream.stopReason === 'max_tokens') {
    return send(res, 502, {
      error: 'Model response was truncated before it produced complete JSON.',
      code: 'invalid_model_output',
      reason: 'truncated',
    });
  }

  let parsed;
  try {
    parsed = parseModelJson(upstream.text);
  } catch {
    return send(res, 502, {
      error: 'Model did not return valid JSON.',
      code: 'invalid_model_output',
      reason: 'unparseable',
    });
  }

  const schemaErrors = validateModelOutput(parsed, {
    knownIds,
    aesthetic: body.vibePack,
    tier: body.tier,
  });
  if (schemaErrors.length > 0) {
    return send(res, 502, {
      error: 'Model returned JSON that does not match the expected schema.',
      code: 'invalid_model_output',
      reason: 'schema_mismatch',
      details: schemaErrors.slice(0, MAX_ERRORS),
    });
  }

  return send(res, 200, parsed);
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Returns human-readable messages naming field paths only — never values,
 * which are user photo data.
 *
 * `count` is intentionally not validated. Older app builds still send it;
 * the model now decides carousel length, so it is ignored rather than rejected.
 */
function validateRequest(body) {
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

      if (!isNonEmptyString(photo.thumbnail)) {
        errors.push(`${at}.thumbnail must be a non-empty base64 string`);
      } else if (detectMediaType(photo.thumbnail, photo.mediaType) === null) {
        errors.push(
          `${at}.thumbnail must be base64 JPEG, PNG, GIF, or WebP ` +
          `(or set ${at}.mediaType explicitly)`
        );
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
      if (!isInUnitRange(m.largestFaceAreaRatio)) {
        errors.push(`${at}.metrics.largestFaceAreaRatio must be a number between 0 and 1`);
      }
      if (!isPositiveInteger(m.width)) {
        errors.push(`${at}.metrics.width must be an integer >= 1`);
      }
      if (!isPositiveInteger(m.height)) {
        errors.push(`${at}.metrics.height must be an integer >= 1`);
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

  // --- tier ---
  if (!TIERS.includes(body.tier)) {
    errors.push(`tier must be one of: ${TIERS.join(', ')}`);
  }

  // --- vibePack ---
  if (!VIBE_PACKS.includes(body.vibePack)) {
    errors.push(`vibePack must be one of: ${VIBE_PACKS.join(', ')}`);
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Anthropic call                                                      */
/* ------------------------------------------------------------------ */

async function callAnthropic({ apiKey, systemPrompt, photos }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // The pack/tier prompt goes here, not in a user turn. It is the
        // stable prefix, which is what makes prompt caching possible.
        // cache_control marks it as a breakpoint: identical (vibePack, tier)
        // requests within the TTL reuse this prefix at ~0.1x its input
        // price instead of paying full price every time. loadSystemPrompt
        // returns the raw file contents verbatim (no per-request
        // interpolation -- no date, no id), so the same pair always
        // renders byte-identical, which prompt caching requires. See
        // README's "Enabling prompt caching" section for the token-count
        // verification and expected savings.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildPhotoContent(photos) }],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw err;
    const wrapped = new Error('upstream request failed');
    wrapped.upstreamStatus = null;
    throw wrapped;
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Drain and discard: the error body may quote request content.
    await response.text().catch(() => {});
    const err = new Error('upstream returned an error status');
    err.upstreamStatus = response.status;
    throw err;
  }

  const payload = await response.json();
  const text = (payload.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');

  return { text, stopReason: payload.stop_reason ?? null };
}

/**
 * One text block naming the photo and its metrics, immediately followed by
 * that photo's image block — so the model cannot lose track of which id
 * belongs to which image.
 */
function buildPhotoContent(photos) {
  const content = [
    {
      type: 'text',
      text:
        `${photos.length} candidate photo${photos.length === 1 ? '' : 's'} follow. ` +
        `Each image is preceded by a line giving its id and metrics.`,
    },
  ];

  for (const photo of photos) {
    const m = photo.metrics;
    content.push({
      type: 'text',
      text:
        `id: ${photo.id}\n` +
        `category: ${m.category}\n` +
        `faceCount: ${m.faceCount}\n` +
        `faceQuality: ${m.faceQuality}\n` +
        `largestFaceAreaRatio: ${m.largestFaceAreaRatio}\n` +
        `clusterID: ${m.clusterID}\n` +
        `timestamp: ${m.timestamp}\n` +
        `width: ${m.width}\n` +
        `height: ${m.height}`,
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: detectMediaType(photo.thumbnail, photo.mediaType),
        data: stripDataUri(photo.thumbnail),
      },
    });
  }

  return content;
}

/* ------------------------------------------------------------------ */
/* Model output parsing and validation                                 */
/* ------------------------------------------------------------------ */

/**
 * Strips markdown code fences, then parses. If that fails, falls back to the
 * outermost {...} span in case the model wrapped the JSON in prose.
 */
function parseModelJson(raw) {
  let text = String(raw ?? '').trim();

  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object found');
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * Validates the model's output against the schema the prompts specify, and
 * verifies every returned photo id actually came from the request. A
 * hallucinated id fails here rather than reaching the app.
 */
function validateModelOutput(out, { knownIds, aesthetic, tier }) {
  const errors = [];

  if (!isPlainObject(out)) return ['response must be a JSON object'];

  if (out.aesthetic !== aesthetic) {
    errors.push(`aesthetic must equal the requested vibePack ("${aesthetic}")`);
  }
  if (out.tier !== tier) {
    errors.push(`tier must equal the requested tier ("${tier}")`);
  }
  if (!POST_CONCEPTS.has(out.postConcept)) {
    errors.push('postConcept must be "cohesive_event" or "life_lately"');
  }
  if (!isNonNegativeInteger(out.selectedCount)) {
    errors.push('selectedCount must be an integer >= 0');
  }
  if (typeof out.insufficientStrongPhotos !== 'boolean') {
    errors.push('insufficientStrongPhotos must be a boolean');
  }

  // --- carousel ---
  // An empty carousel is legitimate when the model found nothing postable —
  // the prompts' `insufficientStrongPhotos` case, taken to its limit. It is
  // only allowed when the model actually set that flag.
  const carouselIds = new Set();
  const carouselIsEmpty = Array.isArray(out.carousel) && out.carousel.length === 0;
  if (!Array.isArray(out.carousel)) {
    errors.push('carousel must be an array');
  } else if (carouselIsEmpty) {
    if (out.insufficientStrongPhotos !== true) {
      errors.push(
        'carousel must not be empty unless insufficientStrongPhotos is true'
      );
    }
  } else if (out.carousel.length > MAX_CAROUSEL) {
    errors.push(`carousel must contain at most ${MAX_CAROUSEL} entries`);
  } else {
    out.carousel.forEach((item, i) => {
      const at = `carousel[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isNonEmptyString(item.id)) {
        errors.push(`${at}.id must be a non-empty string`);
      } else if (!knownIds.has(item.id)) {
        errors.push(`${at}.id is not a photo id from the request`);
      } else if (carouselIds.has(item.id)) {
        errors.push(`${at}.id appears more than once in the carousel`);
      } else {
        carouselIds.add(item.id);
      }
      if (!ROLES.has(item.role)) {
        errors.push(`${at}.role is not an allowed role`);
      }
      if (!isNonEmptyString(item.selectionReason)) {
        errors.push(`${at}.selectionReason must be a non-empty string`);
      }
    });
  }

  // --- alternates ---
  if (!Array.isArray(out.alternates)) {
    errors.push('alternates must be an array');
  } else if (out.alternates.length > MAX_ALTERNATES) {
    errors.push(`alternates must contain at most ${MAX_ALTERNATES} entries`);
  } else {
    out.alternates.forEach((item, i) => {
      const at = `alternates[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isNonEmptyString(item.id)) {
        errors.push(`${at}.id must be a non-empty string`);
      } else if (!knownIds.has(item.id)) {
        errors.push(`${at}.id is not a photo id from the request`);
      }
      if (!ALTERNATE_TYPES.has(item.type)) {
        errors.push(`${at}.type must be "swap" or "extension"`);
      } else if (item.type === 'extension') {
        if (item.replaceId !== null) {
          errors.push(`${at}.replaceId must be null when type is "extension"`);
        }
      } else if (!isNonEmptyString(item.replaceId)) {
        errors.push(`${at}.replaceId must be a photo id when type is "swap"`);
      } else if (!carouselIds.has(item.replaceId)) {
        errors.push(`${at}.replaceId is not an id in the returned carousel`);
      }
      if (!ROLES.has(item.role)) {
        errors.push(`${at}.role is not an allowed role`);
      }
      if (!isNonEmptyString(item.reason)) {
        errors.push(`${at}.reason must be a non-empty string`);
      }
    });
  }

  // --- captions ---
  if (!Array.isArray(out.captions)) {
    errors.push('captions must be an array');
  } else if (out.captions.length === 0) {
    // Captioning nothing is meaningless, so an empty carousel may carry
    // empty captions. A real carousel must still be captioned.
    if (!carouselIsEmpty) {
      errors.push('captions must not be empty when the carousel is non-empty');
    }
  } else if (out.captions.length > MAX_CAPTIONS) {
    errors.push(`captions must contain at most ${MAX_CAPTIONS} entries`);
  } else {
    out.captions.forEach((item, i) => {
      const at = `captions[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isPositiveInteger(item.rank)) {
        errors.push(`${at}.rank must be an integer >= 1`);
      }
      if (!isNonEmptyString(item.text)) {
        errors.push(`${at}.text must be a non-empty string`);
      }
    });
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Returns the image media type for a base64 thumbnail, or null if it isn't a
 * format the API accepts. An explicit `mediaType` on the photo wins; otherwise
 * the type is sniffed from the decoded magic bytes. A `data:` URI prefix is
 * honoured and stripped.
 */
function detectMediaType(thumbnail, explicit) {
  if (isNonEmptyString(explicit)) {
    return SUPPORTED_MEDIA_TYPES.has(explicit) ? explicit : null;
  }

  const dataUri = String(thumbnail).match(/^data:([^;,]+);base64,/i);
  if (dataUri) {
    const declared = dataUri[1].toLowerCase();
    return SUPPORTED_MEDIA_TYPES.has(declared) ? declared : null;
  }

  let head;
  try {
    head = Buffer.from(String(thumbnail).slice(0, 32), 'base64');
  } catch {
    return null;
  }
  if (head.length < 12) return null;

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function stripDataUri(thumbnail) {
  return String(thumbnail).replace(/^data:[^;,]+;base64,/i, '');
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
const isInUnitRange = (v) => isFiniteNumber(v) && v >= 0 && v <= 1;
