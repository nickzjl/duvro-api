/**
 * Mints short-lived signed upload targets on fal's CDN.
 *
 * WHY THIS EXISTS. Photos cannot travel through this server: Vercel caps a
 * function's request AND response body at 4.5 MB, which one full-resolution
 * photo can approach on its own. And FAL_KEY cannot ship in the app — an IPA
 * is trivially unpacked. So the server, holding the key, asks fal for signed
 * URLs and hands only those to the app; the app PUTs bytes straight to fal and
 * the bytes never touch us.
 *
 * ⚠️ THIS ENDPOINT IS NOT IN FAL'S PUBLISHED REST DOCUMENTATION. It is what
 * fal's own official client calls (@fal-ai/client v1.10.1, src/storage.js:
 * `POST ${getRestApiUrl()}/storage/upload/initiate?storage_type=fal-cdn-v3`
 * with `{ content_type, file_name }`, destructuring `{ upload_url, file_url }`
 * from the response). The contract below is transcribed from that source, not
 * guessed — but fal documents no stability promise for it, and their own
 * comment there reads "We want to test V3 without making it the default at the
 * API level". Host, path and the storage_type query are therefore all
 * env-overridable so a fal-side change is a config edit, not a redeploy.
 *
 * The documented alternative, POST /v1/serverless/files/file/local/{path}, is
 * multipart and requires `Authorization: Key ...` from whoever uploads — which
 * would mean shipping the key in the app. It cannot be used here. See README.
 *
 * Privacy: file names and URLs are never logged.
 */

import { authHeaders, getFalConfig, classifyFalError, uploadLifecycleHeaders } from './fal.js';
import { ProviderError } from './providerErrors.js';

export const DEFAULT_STORAGE_TYPE = 'fal-cdn-v3';
export const UPLOAD_INITIATE_PATH = '/storage/upload/initiate';

/** What the app is allowed to ask for an upload target for. */
export const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Asks fal for one signed upload target.
 *
 * @returns {Promise<{uploadUrl: string, fileUrl: string}>}
 * @throws {ProviderError} classified, never carrying fal's raw message
 */
export async function initiateUpload({ contentType, fileName }, { config, fetchImpl = fetch, signal } = {}) {
  const cfg = config ?? getFalConfig();
  const storageType = (process.env.FAL_STORAGE_TYPE ?? DEFAULT_STORAGE_TYPE).trim();
  const url = `${cfg.restHost}${UPLOAD_INITIATE_PATH}?storage_type=${encodeURIComponent(storageType)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...authHeaders(cfg),
        ...uploadLifecycleHeaders(cfg),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    });
    text = await res.text();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ProviderError('upload initiate timed out', {
        code: 'fal_unavailable', retryable: true,
      });
    }
    throw new ProviderError('upload initiate failed', {
      code: 'fal_unavailable', retryable: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!res.ok) {
    const { code, retryable, status } = classifyFalError(res.status, res.headers, text);
    throw new ProviderError('upload initiate rejected', { code, retryable, status });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError('upload initiate returned invalid JSON', {
      code: 'fal_unexpected_response', retryable: true,
    });
  }

  // Fail loudly rather than handing the app a half-formed target: a missing
  // field here means fal changed the contract, and a silently-undefined
  // uploadUrl would surface much later as an inscrutable client-side error.
  const uploadUrl = body?.upload_url;
  const fileUrl = body?.file_url;
  if (typeof uploadUrl !== 'string' || typeof fileUrl !== 'string' || !uploadUrl || !fileUrl) {
    throw new ProviderError('upload initiate response missing upload_url/file_url', {
      code: 'fal_unexpected_response', retryable: false,
    });
  }

  return { uploadUrl, fileUrl };
}

/**
 * Mints `files.length` targets, one per requested file.
 *
 * Concurrent, because these are small independent calls and the app is waiting
 * on all of them before it can start uploading. Any single failure fails the
 * whole request — a partial set would leave the app unable to complete the
 * batch it asked for, and it is cheap to ask again.
 */
export async function createUploadTargets(files, { config, fetchImpl, signal } = {}) {
  const cfg = config ?? getFalConfig();
  return Promise.all(
    files.map((f) => initiateUpload(f, { config: cfg, fetchImpl, signal }))
  );
}

/** `image/jpeg` -> `jpg`, for a filename fal will accept. */
export function extensionForContentType(contentType) {
  switch (String(contentType).toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}
