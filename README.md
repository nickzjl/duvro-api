# duvro-api

Server-side endpoints for duvro (iOS). Separate repo from the app.

- **`POST /api/curate`** takes a batch of camera-roll photos, sends them to
  Claude with the system prompt for the requested aesthetic and tier, and
  returns the model's carousel selection, alternates, and captions.
- **`POST /api/entitlement/check` / `/consume`** read and set the device's one
  free premium post, via Apple DeviceCheck.
- **`POST /api/premium/generate`** runs the premium tier's image generation —
  three generated variants per photo, streamed back as they complete. **No
  image model is chosen yet**; the generation call sits behind a swappable
  interface whose only implementation is a stub.

Zero runtime dependencies (Node's built-in `fetch`). Tests use Node's built-in
runner: `npm test`.

## Privacy invariants

- The request body is **never logged**, echoed, or written to disk. Neither is
  the model's response — it describes the user's photos. The one exception is
  numeric prompt-cache usage counts (`cache_creation_input_tokens`,
  `cache_read_input_tokens`, `input_tokens`, `output_tokens` — never photo data
  or response text) — see "Prompt caching" below for the two opt-in,
  off-by-default gates.
- `ANTHROPIC_API_KEY` is read from `process.env` only. It is never logged, never
  written to a file, and never included in a response. Anthropic error bodies are
  drained and discarded rather than forwarded, since they can quote request content.
- Validation errors name field **paths** (`photos[2].metrics.width`), never
  field **values**.
- **Device tokens are device identifiers** and are treated the same way: never
  logged, never written to disk, never echoed in a response. `APPLE_DEVICECHECK_KEY`
  is read from the environment only and never appears in a response or an error
  message; Apple's raw error text is mapped to our own codes rather than
  forwarded.
- **Photo image data and image URLs never touch a log or the disk.** The premium
  endpoint logs one cost line per batch containing only numeric counters
  (provider name, photos, slots, attempted, retried, generated, fell back, and
  the fallback-reason tally) — no ids, no URLs, no image bytes. A provider's raw
  error message is discarded rather than surfaced, since it can quote request
  content. There is a test asserting neither an image URL nor a device token can
  appear in that line.

## Endpoint

### `POST /api/curate`

**Request body**

```jsonc
{
  "photos": [
    {
      "id": "string, unique within the request",
      "thumbnail": "base64 JPEG, PNG, GIF, or WebP (bare or a data: URI)",
      "mediaType": "optional — overrides format sniffing, e.g. \"image/jpeg\"",
      "metrics": {
        "category": "string",
        "faceCount": 0,               // integer >= 0
        "faceQuality": 0.0,           // any finite number; not range-checked
        "largestFaceAreaRatio": 0.0,  // 0–1, 0 when no faces
        "clusterID": "string or number",
        "timestamp": "ISO 8601 string or numeric epoch",
        "width": 3024,                // orientation-corrected pixels, integer >= 1
        "height": 4032
      }
    }
  ],
  "tier": "basic",            // "basic" | "premium"
  "vibePack": "golden_hour"   // "golden_hour" | "digicam" | "travel_film"
}
```

**`count` is gone.** The model now decides carousel length itself (4–10, or fewer
with `insufficientStrongPhotos: true`). A request that still sends `count` is
accepted and the field is ignored, so an older app build keeps working — it is not
a validation error, whatever its value.

**`vibePack` is now a closed set.** It selects the prompt file, so it must be
exactly `golden_hour`, `digicam`, or `travel_film` — not a display name and not
hyphenated. Anything else is a 400.

At most **100 photos** per request (the Anthropic API's per-request image limit).

**Responses**

| Status | `code` | When |
| --- | --- | --- |
| `200` | — | Success. Body is the model's JSON, passed through as-is. |
| `400` | `invalid_request` | Malformed JSON or a payload that fails shape validation. `details` lists field paths. |
| `405` | `method_not_allowed` | Method is not `POST`. |
| `500` | `server_misconfigured` | `ANTHROPIC_API_KEY` is not set. |
| `502` | `upstream_error` | The Anthropic call failed (non-2xx or network). `upstreamStatus` carries the HTTP status when there was one. |
| `502` | `invalid_model_output` | The model returned unparseable JSON, an unexpected schema, or a photo id that wasn't in the request. `reason` is `unparseable`, `schema_mismatch`, or `truncated`. |
| `504` | `upstream_timeout` | The Anthropic call exceeded 240s. |

The app can distinguish a payload bug (`400`) from a service failure
(`502 upstream_error` / `504`) and fall back to on-device selection on the latter.

**Model output validation.** Before returning, the response is checked against the
schema the prompts specify: `postConcept` and every `role`/`type` against their
enums, `carousel` up to 10 with unique ids, `alternates` ≤ 5,
`replaceId` null for `extension` and an id in the returned carousel for `swap`,
`captions` up to 5. **Every id in `carousel`, `alternates[].id`, and
`alternates[].replaceId` must exist in the request** — a hallucinated id is a 502,
never passed through. Markdown code fences are stripped before parsing, and JSON
wrapped in prose is recovered from the outermost `{...}`.

**"Nothing made the cut" is a success, not an error.** An empty `carousel` is
accepted — and returned as a `200` — when the model sets
`insufficientStrongPhotos: true`. That is the prompts' documented case ("if fewer
than 4 genuinely usable images exist, return the strongest available and set
`insufficientStrongPhotos` to true") taken to its limit of zero, and the app has a
state for it. An empty `carousel` with the flag `false` is still a 502, since that
is the model contradicting itself.

`captions` may be empty **only** when the carousel is empty — captioning nothing
is meaningless. A non-empty carousel must still be captioned, or it's a 502.
Note a `swap` alternate alongside an empty carousel is still a 502: there is
nothing for it to replace.

## Call parameters

- **Model:** `claude-sonnet-4-6`.
- **`max_tokens`: 8192.** Worst realistic response is 10 carousel entries
  (~55 tok each with `selectionReason`) + 5 alternates (~60 each) + 5 captions
  (~15 each) + JSON scaffolding ≈ **1,700 tokens**; doubling for a verbose run
  gives ~3,400. 8192 is roughly 5× the realistic case. `max_tokens` is a cap, not
  a reservation — unused headroom costs nothing, and truncation would produce
  invalid JSON, so the margin is worth having. If the model does hit the cap, that
  returns `502 invalid_model_output` with `reason: "truncated"` rather than
  garbage.
- **The system prompt goes in the `system` parameter**, as a content-block array —
  never as a user message. Each photo contributes a text block naming its id and
  metrics, immediately followed by that photo's image block, so the model can't
  lose track of which id belongs to which image.

## Timeout

Vercel's Hobby plan (with Fluid Compute, the default) is **300s default and 300s
maximum** — the old 10s Hobby ceiling no longer applies. `vercel.json` sets
`maxDuration: 300`.

**That is comfortably enough** for the expected 20–45s at 30 photos, with roughly
6× headroom. The handler aborts its own upstream call at **240s** so a hung request
returns a clean `504` JSON body instead of Vercel's HTML timeout page. If you want
the app to give up sooner, lower `UPSTREAM_TIMEOUT_MS` in
[api/curate.js](api/curate.js) rather than `maxDuration`.

## Entitlements (DeviceCheck)

duvro's premium tier gives every device **one free premium post, ever**. There
are no accounts, so there is no user identity to hang that off — Apple's
[DeviceCheck](https://developer.apple.com/documentation/devicecheck) provides two
bits of per-device state that survive app deletion and reinstall.

**Apple stores the bits, not us.** The app calls `DCDevice.generateToken()` and
sends the token here; this server signs a JWT and asks Apple to read or write the
bits. No database — that is the distinction from App Attest.

| Bit | Meaning |
| --- | --- |
| `bit0` | This device has used its free premium post |
| `bit1` | Reserved — always written `false` |

### `POST /api/entitlement/check`

Read-only. Never writes bits.

```jsonc
// request
{ "deviceToken": "<base64 from DCDevice.generateToken()>" }
```

```jsonc
// 200
{
  "freePremiumPostAvailable": true,
  "consumed": false,
  "bit0": false,
  "bit1": false,
  "lastUpdateTime": null,   // Apple returns "YYYY-MM", null if never set
  "environment": "production"
}
```

A device Apple has no record of is **not an error** — Apple answers `200` with a
plain-text `Failed to find bit state` body, which is reported as both bits
`false` (a fresh device with its free post intact).

### `POST /api/entitlement/consume`

Marks the free premium post as used by setting `bit0` true.

```jsonc
// request
{ "deviceToken": "<base64 from DCDevice.generateToken()>" }
```

```jsonc
// 200
{
  "freePremiumPostAvailable": false,
  "consumed": true,
  "alreadyConsumed": false,  // true if it was already consumed before this call
  "bit0": true,
  "bit1": false,
  "lastUpdateTime": null,
  "environment": "production"
}
```

**Idempotent.** Consuming an already-consumed entitlement is a `200` with the
same resulting state, not an error — only `alreadyConsumed` differs. The bits are
read before writing, so a repeat call costs no write, and the app can tell
whether *this* call was the one that consumed the entitlement.

`bit1` is written explicitly as `false` because Apple has no partial update — an
update always sets both bits. On the short-circuit path (already consumed) no
write happens at all, so an existing `bit1` is reported rather than cleared.

`lastUpdateTime` is `null` on a call that performed the write, since Apple
returns an empty body from `update_two_bits`; a later `check` reports it.

⚠️ **Not atomic.** DeviceCheck offers no compare-and-swap, so two `consume`
calls racing for the same device can both read `bit0: false` and both report
`alreadyConsumed: false`. The final bit state is still correct, but if you need
"exactly one free post" to be airtight against a client retrying in parallel,
serialise consume calls app-side. In practice the app consumes once at the end
of a post, so this is a narrow window.

### Error codes

Apple replies in plain text, and its exact wording is not contractual. Responses
are mapped to codes the app can branch on; **Apple's raw text is never
forwarded**.

| Status | `code` | Meaning for the app |
| --- | --- | --- |
| `400` | `invalid_request` | Malformed JSON, or `deviceToken` missing/not base64. |
| `400` | `invalid_device_token` | Apple rejected the token. Generate a fresh one and retry once. |
| `400` | `device_token_already_used` | Token was already spent; generate a fresh one. |
| `400` | `unsupported_device` | Device has no DeviceCheck support. Fall back — don't retry. |
| `405` | `method_not_allowed` | Not `POST`. |
| `429` | `rate_limited` | Apple is throttling. Back off and retry. |
| `500` | `server_misconfigured` | Our key/key id/team id is wrong, or an env var is missing. Not the app's fault; retrying won't help. |
| `502` | `apple_unavailable` | Apple is down or unreachable. Retry with backoff. |
| `504` | `apple_timeout` | Apple didn't answer within 10s. |
| `502` | `apple_unexpected` | Something Apple returned that we don't recognise. |

### Environment variables

| Variable | Value |
| --- | --- |
| `APPLE_DEVICECHECK_KEY` | Contents of the `.p8` private key |
| `APPLE_DEVICECHECK_KEY_ID` | The key's 10-character Key ID |
| `APPLE_TEAM_ID` | Your 10-character Apple Team ID |
| `APPLE_DEVICECHECK_ENV` | `production` (default) or `development` |

`APPLE_DEVICECHECK_KEY` is accepted with real newlines, with literal `\n`
escapes, or as the whole PEM base64-encoded — whichever survives your paste into
the Vercel dashboard.

### Switching between the development and production hosts

Set `APPLE_DEVICECHECK_ENV`:

| Value | Host |
| --- | --- |
| `production` (default) | `api.devicecheck.apple.com` |
| `development` | `api.development.devicecheck.apple.com` |

```bash
vercel env add APPLE_DEVICECHECK_ENV
```

Then redeploy — env vars are read at request time, but a redeploy is what picks
up the new value for an existing deployment.

**A token minted by a development build only validates against the development
host, and vice versa.** Get it wrong and Apple rejects the token, which surfaces
as `invalid_device_token`.

⚠️ **The two hosts keep entirely separate bit storage.** A device that consumed
its free post against the development host still reads `bit0: false` on
production. Don't treat development results as a preview of production state —
and don't flip a live deployment to `development` to debug, or every user's
entitlement silently resets. The environment used is echoed in every response as
`environment` so a misconfiguration is visible rather than silent.

Default is `production` deliberately: a missing or misspelled env var should not
quietly point live traffic at the development bit store.

### Rotating the DeviceCheck key

1. In the Apple Developer portal → **Certificates, Identifiers & Profiles → Keys**,
   create a new key with **DeviceCheck** enabled. Download the `.p8` — Apple
   allows this **once**, so store it in a password manager immediately.
2. Update both variables together, in this order:
   ```bash
   vercel env rm APPLE_DEVICECHECK_KEY production
   vercel env add APPLE_DEVICECHECK_KEY production      # paste the new .p8 contents
   vercel env rm APPLE_DEVICECHECK_KEY_ID production
   vercel env add APPLE_DEVICECHECK_KEY_ID production   # the new Key ID
   ```
   The key and its Key ID are a **pair** — a new key with a stale `KEY_ID` fails
   Apple's auth with `server_misconfigured`.
3. Redeploy, then verify with a real device before revoking the old key.
4. Revoke the old key in the portal.

`APPLE_TEAM_ID` does not change on rotation. Signing JWTs are cached in memory
for 30 minutes per warm instance, keyed on key id + team id + environment, so a
rotation takes effect on new instances immediately and on warm ones within half
an hour — force it sooner by redeploying.

**The bits are unaffected by rotation.** They live with Apple, keyed to the
device and your team — not to the signing key.

### DeviceCheck does not work in the Simulator

`DCDevice.isSupported` is `false` in the iOS Simulator and
`generateToken()` fails there. **All real testing has to be on a physical
device.** The server has no way to distinguish a Simulator from a hardware
device — it only ever sees the token — so a Simulator build simply cannot reach
these endpoints with anything Apple will accept.

## Premium tier

Basic renders three variants per photo locally with Core Image — 8–17ms each,
free and deterministic. Premium replaces those three local renders with three
generated ones, so a 7-photo post is **21 generations**. The app then picks
between them in the existing three-way edit screen, unchanged.

**No image model has been chosen.** Everything here is built around the
generation call; the call itself sits behind
[lib/imageProvider.js](lib/imageProvider.js) and the only implementation is a
stub that returns its input unchanged. The whole pipeline runs end to end on
the stub, which is how it was tested.

### The generation provider

`IMAGE_PROVIDER` selects it. Two implementations:

| `IMAGE_PROVIDER` | What it does |
| --- | --- |
| `stub` (**default**) | Returns the input image unchanged. No credentials, no spend. The offline/CI implementation — not a placeholder to be deleted. |
| `fal` | Runs **`fal-ai/flux-pro/kontext`** for real. |

The default is `stub` on purpose: nothing spends money by accident.

**The request body**, verified field-by-field against the model's OpenAPI schema
(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-pro/kontext`):

```jsonc
{
  "prompt": "<the style instruction>",   // the edit instruction
  "image_url": "https://…",              // the source photo
  "num_images": 1,
  "output_format": "jpeg",
  "sync_mode": false,
  "safety_tolerance": "2"
}
```

Four things there are easy to get wrong, and each has a test:

- **`sync_mode` must stay `false`.** `true` makes fal return the image as a
  **data URI** rather than a CDN URL — the exact payload shape this whole
  architecture exists to avoid. The provider also rejects a `data:` URL if one
  ever comes back anyway.
- **`safety_tolerance` is a string**, `"2"`, not the integer `2`. An integer is
  a 422.
- **`aspect_ratio` is deliberately omitted.** It has no default; setting one
  would re-frame the user's photo.
- **`num_inference_steps` is not a field on this model** — despite appearing in
  fal's own playground prefill for it and on sibling flux-pro models. Not sent.

**Output** is `images[0].url` — a fal CDN URL, plus `content_type`. The batch
returns those URLs to the app, which downloads them directly; generated bytes
never pass through this server either.

### Queue, not sync

fal offers both `POST https://fal.run/{model}` (synchronous) and
`POST https://queue.fal.run/{model}` (submit → poll status → fetch result).
**This uses the queue**, for three reasons:

1. **Contention becomes waiting rather than failure.** fal's concurrency limit
   is per *account*, and their docs are explicit that `fal.run` has "no queue".
   Two devices generating at once put double our configured concurrency against
   the same cap; on the sync endpoint the excess returns `429`, which after our
   retry-once becomes a user-visible fallback. On the queue, fal's own docs say
   requests "are never rejected due to concurrency limits" — they wait.
2. **No long-held connection.** A sync call parks one HTTP connection for the
   whole generation. Each queue call is sub-second, so nothing is exposed to an
   intermediary's idle timeout — and fal documents **no maximum duration** for
   `fal.run` that we could design against.
3. **Failures arrive structured.** A queue failure returns status `COMPLETED`
   carrying `error_type`, which maps straight onto our retryable/non-retryable
   policy.

⚠️ **There is no `FAILED` status.** The only three are `IN_QUEUE`,
`IN_PROGRESS`, `COMPLETED` — the string `FAILED` does not occur anywhere in
fal's documentation. A failed generation *completes*, carrying `error` and
`error_type`. Code that waits for a failure status would hang until the
deadline; code that treats `COMPLETED` as success would report a success that
never happened. The provider checks for `error` on every `COMPLETED`.

**Polling** starts at 500ms and backs off ×1.35 to a 3s ceiling. It costs one
extra round trip plus a handful of small status calls per generation, all paid
for out of the per-call timeout the batch already clamps to the remaining
deadline. Aborting (client hangs up, or the batch deadline hits) sends
`PUT {cancel_url}` so fal stops working on something nobody will collect.

**Retryability** follows fal's own semantics rather than a status-code guess:
its `X-Fal-Needs-Retry` header wins when present; `429`
(`concurrent_requests_limit`) and 5xx are retryable; `401`/`403` (our key) and
`422` are not. `content_policy_violation` keeps its own code all the way out to
the app and is **never retried** — a second attempt costs money to be rejected
identically.

### Getting photos to fal: `POST /api/premium/upload-targets`

Photos reach the generator by being uploaded **directly from the app to fal's
CDN**. They never pass through this server, and `FAL_KEY` never reaches the app.

```
app  ──▶ POST /api/premium/upload-targets      "7 photos, image/jpeg"
here ──▶ fal  POST /storage/upload/initiate    ×7, with FAL_KEY
here ──▶ app  [{ uploadUrl, fileUrl }, …]
app  ──▶ fal  PUT bytes to each uploadUrl      no key involved
app  ──▶ POST /api/premium/generate            with the fileUrls
```

Both halves are forced, not chosen. Vercel caps a function's request *and*
response body at **4.5 MB**, so bytes cannot transit this server; and an IPA is
trivially unpacked, so the key cannot ship in the app.

**Request**

```jsonc
{
  "deviceToken": "base64",              // Apple DeviceCheck token
  "files": [
    { "contentType": "image/jpeg", "fileName": "IMG_0042.HEIC" }  // fileName optional
  ]
}
```

`contentType` must be one of `image/jpeg`, `image/png`, `image/heic`,
`image/heif`, `image/webp`. At most **10** files — the same ceiling
`/api/premium/generate` enforces. `fileName` is sanitised to a safe stem plus an
extension derived from `contentType`; it reaches a third party, so it is never
passed through raw.

**Response**

```jsonc
{
  "targets": [
    {
      "uploadUrl": "https://…",          // PUT the bytes here
      "fileUrl": "https://v3.fal.media/files/…",  // send THIS to /api/premium/generate
      "method": "PUT",
      "headers": { "Content-Type": "image/jpeg" },
      "contentType": "image/jpeg"
    }
  ],
  "expiresInSeconds": null,              // fal documents no validity window — upload promptly
  "objectExpirySeconds": 86400
}
```

The app uploads with a plain `PUT` — no `Authorization` header, no fal
credentials:

```
PUT <uploadUrl>
Content-Type: image/jpeg
<raw bytes>
```

**Why it needs a device token.** An open endpoint minting upload URLs against
our paid fal account is free file hosting for whoever finds it. The token is
verified with Apple, so forged tokens get nothing. The entitlement **bit is
deliberately not checked** — uploading happens before generation, and a future
paying user will already have `bit0` set. This proves "a real Apple device
asked", not "this device is entitled"; entitlement stays enforced at
`/api/premium/generate`.

**Uploaded photos and generated images expire.** fal's default is to keep
objects forever, which sits badly with a product whose pitch is that nothing is
retained. Every upload carries `X-Fal-Object-Lifecycle` and every generation
carries `X-Fal-Object-Lifecycle-Preference` (fal uses two different header names
for the two cases), both set from `FAL_OBJECT_EXPIRY_SECONDS`, default **24h**.
Set it to `0` to opt out. **The app must download generated images before they
expire** — expired objects are permanently deleted.

> ⚠️ **`/storage/upload/initiate` is thinly documented.** It appears in fal's
> docs exactly once — a cURL example under "Setting an ACL on a direct upload"
> on the [file access controls](https://fal.ai/docs/documentation/model-apis/file-access-controls)
> page — and nowhere else: no reference page, no schema, no error table, and it
> is absent from the Platform API's OpenAPI spec. The contract used here was
> cross-checked against that example *and* against fal's own clients
> (`@fal-ai/client` v1.10.1 `src/storage.js`, and the Python client), which
> agree on it. `FAL_REST_HOST` and `FAL_STORAGE_TYPE` are env-overridable so a
> fal-side change is a config edit rather than a redeploy.
>
> One place the two sources **disagree**: the docs example sets
> `X-Fal-Object-Lifecycle-Preference` on the initiate call, while fal's JS client
> sets `X-Fal-Object-Lifecycle` there and reserves the `-Preference` spelling for
> inference. We send both — an unrecognised header costs nothing, whereas sending
> only the wrong one means user photos silently never expire.

### The upload endpoint choice

You asked me to check both candidates. Only one of them can work:

| Candidate | Verdict |
| --- | --- |
| `POST /v1/serverless/files/file/local/{target_path}` (multipart) | **Unusable.** Documented, stable — and requires `Authorization: Key …` from *whoever uploads*. Using it means either shipping the key in the app or routing bytes through this server, and both are exactly what the architecture exists to avoid. |
| `POST /storage/upload/initiate` (signed URL) | **Used.** Returns a signed `upload_url` the app `PUT`s to with **no `Authorization` header at all** — which is what makes it safe to hand to an untrusted client. Thinly documented (see above), but fal's own SDKs use it. |
| `POST /v1/storage/files/sign` | Not applicable — signs for **read** access to an existing file, not for upload. |

### `POST /api/premium/generate`

**Request**

```jsonc
{
  "deviceToken": "base64",       // Apple DeviceCheck token — same as /api/entitlement/*
  "vibePack": "golden_hour",     // golden_hour | digicam | travel_film
  "photos": [
    {
      "id": "p1",                // unique within the request; echoed on every slot
      "url": "https://…",        // https, full-resolution, publicly fetchable
      "mediaType": "image/jpeg"  // optional
    }
  ]
}
```

At most **10 photos** (30 generations) per request — the same carousel ceiling
`/api/curate` enforces.

**Photos are sent as URLs, not bytes.** Vercel caps a function's request *and*
response body at **4.5 MB**. One full-resolution photo can approach that on its
own, seven cannot fit, and 21 generated ones exceed it by an order of
magnitude — so inline base64 is not an option in either direction, at any
quality setting. See "The open decision" below, because this is the one piece
of the design that is not finished.

**Response: an NDJSON stream**, `application/x-ndjson`. One JSON object per
line, written as work completes:

```jsonc
{"type":"start","totalSlots":21,"photos":7,"variantsPerPhoto":3,"concurrency":3,"provider":"stub","placeholderInstructions":3}
{"type":"slot","photoId":"p1","variant":"Sun-kissed","variantIndex":0,"status":"generated","url":"https://…","mediaType":"image/jpeg","attempts":1,"completed":1,"totalSlots":21}
{"type":"slot","photoId":"p1","variant":"Warm Film","variantIndex":1,"status":"fallback","fallbackReason":"provider_timeout","attempts":2,"completed":2,"totalSlots":21}
…
{"type":"done","counts":{…}}
{"type":"complete","counts":{…},"slots":[ …every slot again… ]}
```

- **`slot`** — one per (photo, variant). `status` is `generated` (use `url`) or
  `fallback` (**render this variant locally with Core Image, exactly as on the
  free tier**). `completed`/`totalSlots` drive the progress bar.
- **`complete`** — the terminal line, repeating every slot. A client that
  ignored the incremental events still has the full result from this one
  object, so the stream is an optimisation for perceived speed, not a
  protocol you are forced to track statefully.
- Slots arrive **photo-major** — all three variants of photo 1, then photo 2 —
  so the edit screen can open on photo 1 without waiting for the batch.

`fallbackReason` is one of `provider_timeout`, `provider_error`,
`batch_deadline` (the batch ran out of time before this slot started), or
`cancelled`.

**Pre-stream errors** are ordinary JSON with a real status code, because
nothing has been written yet:

| Status | `code` | When |
| --- | --- | --- |
| `400` | `invalid_request` | Bad JSON, unknown pack, over the cap, bad image URL |
| `402` | `entitlement_required` | The device's free premium post is already spent |
| `405` | `method_not_allowed` | Not `POST` |
| `500` | `server_misconfigured` | Apple or provider env vars missing/invalid |
| `502`/`504` | (DeviceCheck codes) | Apple unreachable — see Error codes above |

Once the stream opens the status is committed to `200`; a structural failure
after that point arrives as a `{"type":"error"}` line instead.

### Why streaming, and not polling

Polling is the obvious alternative and it does not fit here. A Vercel function
is **stateless between invocations** and cannot reliably keep working after it
responds, so a job-id + poll design needs external storage (Redis/KV) to hold
job state *and* something to run the work — two new dependencies for a repo
that currently has zero, to solve a problem that fits in one invocation.

Streaming needs none of that: one invocation does the work and reports as it
goes. The cost is that the whole batch must fit inside `maxDuration`, which is
**300s and not extendable on Hobby** — and the batch is built around that
ceiling rather than hoping to stay under it (see the deadline behaviour below).

Verified over real HTTP with the stub at 120ms latency and concurrency 3: nine
slot lines arrived in three groups at 138ms/260ms/384ms, not together at the
end. **Not yet verified on a real deployment** — whether Vercel's edge buffers
the response is the one thing that can only be checked by deploying, and this
is the first thing to confirm when you do. If it turns out buffered, the
`complete` line means the app still works correctly; it just loses live
progress.

### What the app needs to do

1. `POST /api/entitlement/check` (existing) to know whether premium is offered.
2. Upload the chosen full-resolution photos somewhere https-fetchable and
   collect their URLs. **This step does not exist yet** — see below.
3. `POST /api/premium/generate` and read the response line by line
   (`URLSession.bytes(for:)`, split on `\n`, decode each line).
4. Drive the progress UI from `completed`/`totalSlots`.
5. For each `slot`: `generated` → download `url`; `fallback` → render that one
   variant locally with the existing Core Image chain. A post can legitimately
   mix the two, per-variant, and the user should not be able to tell.
6. `POST /api/entitlement/consume` (existing) when the post is actually
   committed.

**Preview must be a downsample of the exact image that exports.** Generation is
non-deterministic, so generating a small preview and regenerating at full
resolution for export would hand the user something they never approved —
breaking Phase 6's preview-matches-export-1:1 guarantee. Everything server-side
is full-resolution for this reason; the app downsamples for display and exports
that same asset.

### The open decision: where the images live

The endpoint takes URLs in and hands URLs back, and with the stub that closes
cleanly because the stub returns its input. **A real provider will not.** Two
gaps remain, both genuinely blocked on the provider choice rather than on
effort:

- **Upload.** The app has to get full-resolution photos to an https URL before
  calling this. Vercel Blob's client-upload flow is the natural fit (it uploads
  straight to storage, bypassing the 4.5 MB function limit), but it is a new
  dependency and this repo has none.
- **Output.** If the chosen provider returns a **URL**, it passes straight
  through and nothing more is needed. If it returns **bytes**, they need
  somewhere to go — the same blob store — because they cannot be inlined in the
  response. `lib/imageProvider.js` already allows either shape
  (`{ url }` or `{ bytes }`); only the storing half is unbuilt.

Pick the provider first: "does it return a URL or bytes" decides whether the
second gap exists at all.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_PROVIDER` | `stub` | Which implementation to use. Swapping providers is a config change. |
| `IMAGE_PROVIDER_CONCURRENCY` | `3` | Max simultaneous generations. **Set this to the provider's real cap.** |
| `IMAGE_PROVIDER_TIMEOUT_MS` | `90000` | Per-call ceiling. Enforced by racing, so it holds even if a provider ignores its abort signal. |
| `PREMIUM_ALLOWED_IMAGE_HOSTS` | unset | Optional comma-separated host allowlist for photo URLs. |
| `IMAGE_PROVIDER_STUB_DELAY_MS` | `0` | Stub only — fake latency, for watching progress pacing. |
| `IMAGE_PROVIDER_STUB_FAIL_RATE` | `0` | Stub only — 0–1, forces the retry/fallback path. |

### If the provider's concurrency cap is very low

**This is the design's main sensitivity, and it degrades rather than breaks.**
The batch carries its own deadline (300s minus a 20s margin for writing the
response) and stops *starting* generations once too little time remains; those
slots return `fallbackReason: "batch_deadline"` and the app renders them
locally. So a low cap never produces a failed request or a killed function — it
produces a post with more locally-rendered variants in it.

The arithmetic for 21 generations, assuming ~15s each:

| Concurrency | Wall clock | Fits in 280s? |
| --- | --- | --- |
| 5 | ~63s | yes, comfortably |
| 3 | ~105s | yes |
| 2 | ~158s | yes |
| 1 | ~315s | **no** — roughly the last third falls back |

At ~30s per generation, concurrency 2 is already marginal and 1 fails most of
the batch. Two mitigations exist if a real provider lands there, neither built:

- **Split the batch across requests** — the app calls the endpoint once per
  photo (3 generations) instead of once per post. Each call gets its own fresh
  300s, which removes the ceiling as a constraint entirely. This is the real
  fix, it is a small change to this endpoint, and it is worth doing the moment
  measured latency × 21 ÷ concurrency approaches 280s. It costs more
  invocations and a little more app-side orchestration.
- **Generate fewer than three variants per photo** — a product change, not a
  technical one, and it weakens the three-way edit screen that is the app's
  signature interaction. Mentioned for completeness; not recommended.

One thing that is *not* a mitigation: raising `IMAGE_PROVIDER_CONCURRENCY`
above the provider's real cap. That converts a slow batch into a rate-limited
one, and rate-limit errors consume the retry and land in fallback anyway.

### Known gap: an entitled device can call this repeatedly

Verification is read-only — it checks the device's DeviceCheck bit but does not
set it, so consuming stays the app's explicit separate call and an abandoned or
failed batch does not silently burn the user's one free post. The cost is that
a device with an unspent entitlement can call `generate` as often as it likes,
and each call is real money.

Three options, none implemented, in rough order of preference:

1. **Consume first, refund on total failure** — set the bit before generating,
   clear it if every slot fell back. Closes the hole; needs a defensible
   definition of "failed enough to refund".
2. **A short server-side cooldown per device** — needs the same external store
   as everything else in this file.
3. **A WAF rate limit on this path specifically** — see "Rate limiting" above.
   Cheapest, and bounds the blast radius without closing the hole.

The daily spend cap bounds the worst case in dollars today, as it does for
`/api/curate`.

## Prompts

Six plain-text files in [prompts/](prompts), loaded by `<vibePack>.<tier>.txt` and
cached in memory per warm instance:

```
prompts/golden_hour.basic.txt     prompts/golden_hour.premium.txt
prompts/digicam.basic.txt         prompts/digicam.premium.txt
prompts/travel_film.basic.txt     prompts/travel_film.premium.txt
```

Edit them directly — no code change or redeploy of logic needed, just a redeploy.
`vercel.json` includes `prompts/**` in the function bundle so they ship with the
deployment.

The carousel range was changed from 4–20 to 4–10 in all six, including the worked
examples that referenced counts above 10. Everything else is verbatim.

### Style instructions (premium)

Nine more plain-text files in [prompts/styles/](prompts/styles), one per
(pack, variant), loaded by [lib/styles.js](lib/styles.js) exactly the way the
six above are loaded — `<vibePack>.<variant-slug>.txt`, read once per warm
instance and cached.

```
golden_hour.sun-kissed.txt   digicam.light-leak.txt    travel_film.kodak-style.txt
golden_hour.warm-film.txt    digicam.polaroid.txt      travel_film.faded-postcard.txt
golden_hour.soft-glow.txt    digicam.y2k-digicam.txt   travel_film.deep-teal.txt
```

**All nine are placeholders.** Instruction phrasing is model-specific and no
model is chosen, so each file instead pins down what the real instruction has
to reproduce: the look in plain terms, the failure modes already known from
tuning the basic tier, and that variant's own hand-graded Core Image values
from the app's pack JSON — premium must read as the same aesthetic executed
better, not as a different look.

Each carries a `TODO(style-instruction)` marker on line 1. The endpoint counts
them and reports the number in its `start` event
(`placeholderInstructions`), so a wrong-looking render is never mistaken for an
instruction nobody wrote. Remove the marker when you write the real one.

The variant **display names** are the wire format, taken verbatim from the
app's `duvro/Packs/*.json` — there is no second identifier to keep in sync.
Slugs exist only as filenames. Matching is case- and whitespace-insensitive,
but pairing a variant with the wrong pack is an error, not a near-miss.

### Prompt caching

**On.** `system` in [api/curate.js](api/curate.js) carries a `cache_control:
{ type: 'ephemeral' }` breakpoint on its one text block:

```js
system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
```

This is safe to cache because `loadSystemPrompt` returns each prompt file's
contents verbatim — no per-request interpolation (no date, no id, no
per-user text) — so every call for the same `(vibePack, tier)` pair renders
a byte-identical prefix. `messages` (the photos) is never cached; it's
different on every call by design.

**Minimum cacheable length.** `claude-sonnet-4-6`'s minimum is **1,024
tokens** — shorter prefixes silently don't cache (no error, just
`cache_creation_input_tokens: 0`). All six prompts clear it comfortably:

| Prompt | Est. tokens |
| --- | ---: |
| `travel_film.basic.txt` | ~2,700 |
| `digicam.premium.txt` | ~2,730 |
| `travel_film.premium.txt` | ~2,980 |
| `digicam.basic.txt` | ~3,120 |
| `golden_hour.premium.txt` | ~3,880 |
| `golden_hour.basic.txt` | ~4,740 |

None fall below the minimum — the smallest still clears it by 2.6×. (Token
counts are a chars/4 estimate, not a `messages.count_tokens` call — no API
key was available locally to verify exactly. Confirm the real figures from
`usage.cache_creation_input_tokens` on the first live call per pack+tier;
the estimate is unlikely to be off by more than ~10%.)

**Expected per-call saving.** At `claude-sonnet-4-6`'s $3.00/1M input rate,
a cache **read** costs ~0.1× ($0.30/1M) and a cache **write** (the default
5-minute TTL) costs ~1.25× ($3.75/1M) — so the very first call to a given
pack+tier pair, or any call after a 5-minute gap, costs slightly *more*
(~$0.0025–0.0036, ~0.25–0.36¢, depending on which prompt) than before
caching. Every call after that within the TTL is a hit:

- **On just the cached slice:** ~90% off, ~$0.007–0.013 (~0.7–1.3¢) saved
  per call depending on prompt size, ~$0.009 average.
- **On the whole call:** for a representative ~30-photo request (the
  shortlist's usual size), the system prompt is roughly a fifth of total
  input tokens — the photos and their metrics dominate, at ~300–400 tokens
  per downsampled thumbnail plus ~75 for its metrics text. That puts the
  *whole-call* input saving at roughly **20%** once warm, not 90% — the 90%
  figure is real but only applies to the ~3,360-token slice caching
  actually touches, not the photo payload sitting after it.

Two hits already beat two uncached calls outright (write 1.25× + read 0.1×
= 1.35× vs. 2× at full price for two calls) — this pays for itself fast
under any real traffic pattern, including a single retry.

**Verifying hits are actually landing** — two opt-in, off-by-default gates,
both numeric-only (see Privacy invariants above):

- Set `LOG_CACHE_USAGE=1` in the Vercel project's env vars to have every
  call `console.log` its `cache_creation_input_tokens` /
  `cache_read_input_tokens` / `input_tokens` / `output_tokens`, alongside
  the `vibePack`/`tier` it ran with. Check via `vercel logs`.
- `tools/curate-test.mjs` always sends `x-debug-cache-usage: 1` (it's a
  dev tool, never real traffic) and the endpoint echoes those same four
  numbers back as `_cacheDebug` in its response when that header is
  present — the tool prints them under "Summary" with a HIT/MISS verdict
  (`cache_read_input_tokens > 0` → HIT). Real app traffic never sends the
  header, so it never sees `_cacheDebug` and the response shape stays
  exactly the model's own JSON for every real caller.

Don't rely on the Anthropic console's Caching page alone while testing —
it can lag by a few minutes; the response's own `usage` object (via either
gate above) is the immediate, authoritative source.

## Setup

Set `ANTHROPIC_API_KEY` in the Vercel project (Settings → Environment Variables),
or for local `vercel dev`, copy [.env.example](.env.example) to `.env.local` and
fill it in. `.env*` is gitignored.

Deploy with `vercel` — this repo does not deploy itself.

## Rate limiting

Nothing currently stops a caller from hitting `/api/curate` in a tight loop
on the shared `ANTHROPIC_API_KEY`. The hard daily spend cap bounds the
worst case in dollars, but doesn't stop the loop itself. This is a platform
firewall rule, not application code — **nothing in this repo enforces it**;
it's configured on Vercel and only documented here.

**The platform feature covers this — no function code needed.** Vercel's
WAF `rate_limit` custom-rule action runs at the edge, before the function
executes, so a blocked request never invokes `curate.js` and never reaches
Anthropic. Confirmed on the **Hobby** plan (checked against the live docs,
not assumed):

| | Hobby |
| --- | --- |
| Custom firewall rules | Up to 3 total |
| Rate-limit rules specifically | 1 |
| Counting keys | IP or JA4 digest |
| Algorithm | Fixed window only (Token bucket is Enterprise) |
| Window | 10s–**10 min** (Enterprise goes to 1hr) |
| Included allowed requests | 1,000,000/month, free |

**Rate limiting can't be expressed in `vercel.json`.** Vercel does support
WAF rules as code there via `routes[].mitigate`, but only for `deny` and
`challenge` — `rate_limit` (and `log`/`bypass`/`redirect`) are dashboard/CLI
only. That's why this is a runbook section instead of a diff.

**What the rule actually bounds.** The 10-minute window ceiling means this
cannot express "a handful of calls per day" as a single native rule — that
would need a much longer window than Hobby (or even Enterprise, capped at
1hr) allows. What it *can* do, precisely: stop a tight request loop, which
is the actual threat described — a legitimate session makes one call and
waits 20–60s for it, so a real user is nowhere near a per-10-minute cap
even retrying a few times; a loop calling every 1–2s hits it almost
immediately and is blocked for the rest of that window. Treat this as
burst/loop protection layered under the spend cap, not a replacement for
one — they bound different things.

**Suggested rule** (conservative — 20 requests/IP per 10 minutes on the
one endpoint that calls Anthropic; adjust `--rate-limit-requests` down if
real traffic shows room to tighten it):

```bash
vercel link   # once, if this project isn't linked yet

# Stage 1 — log only, enforces nothing yet
vercel firewall rules add "Rate limit /api/curate by IP" \
  --condition '{"type":"path","op":"pre","value":"/api/curate"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit \
  --rate-limit-window 600 \
  --rate-limit-requests 20 \
  --rate-limit-keys ip \
  --rate-limit-action log \
  --yes
vercel firewall diff
vercel firewall publish --yes
```

Watch the Firewall traffic dashboard for a day or so to confirm only
loop-shaped traffic (or nothing) matches, then tighten to actually enforce:

```bash
# Stage 2 — same rule, now actually rejects over-limit requests with 429
vercel firewall rules edit "Rate limit /api/curate by IP" \
  --condition '{"type":"path","op":"pre","value":"/api/curate"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit \
  --rate-limit-window 600 \
  --rate-limit-requests 20 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit \
  --yes
vercel firewall publish --yes
```

A rejected request never reaches this codebase, so it gets Vercel's own
429, not one of `curate.js`'s `{error, code, details}` bodies. That's fine
on the app side without any change there: `CurationService.performRequest`
(iOS) already treats any non-200 as a generic failure and falls back to
on-device selection regardless of the response body shape — it doesn't
require a parseable `ErrorBody`.

**Why this isn't implemented in-function instead.** A Vercel serverless
function is stateless between invocations — a plain in-memory counter
resets (or is inconsistent across concurrent instances) on every cold
start and every scale-out, so it would silently undercount and let a loop
through while looking like it works in casual testing. Doing this
correctly in-function would need a request counter in external storage
that every invocation reads and increments atomically — Vercel KV or
Upstash Redis (`INCR` + `EXPIRE` per IP), the same category of store this
repo would need for App Attest device-key persistence (see below). Since
the platform feature already covers the actual threat here for free, that
storage dependency isn't worth taking on just for this.

## Testing the prompts with real photos

`tools/curate-test.mjs` sends a folder of real photos through the deployed
endpoint, so the prompts can be judged on real images instead of hand-pasted
base64. It is a **dev tool only** — excluded from deploys via `.vercelignore`,
writes nothing to the repo, and prints base64 and responses to stdout only.

```bash
node tools/curate-test.mjs ./test-photos --pack golden_hour --tier basic --url https://YOUR-DEPLOYMENT.vercel.app
```

`--url` may be replaced by a `DUVRO_API_URL` env var. Add `--dry-run` to build
the payload and see the size and derived metrics without spending an API call.
Other flags: `--max-dim` (long edge, default 512) and `--quality` (JPEG, default 70).

Each photo is downsampled to 512px on the long edge and re-encoded as JPEG.
Photos are sent with **opaque ids** (`p01`, `p02`, …), not filenames, so the model
can't take hints from names the way it never could in production — the tool prints
the filename next to every returned id for you. It also reports request size,
wall-clock time, and the carousel length the model chose.

`test-photos/` is gitignored, so that's the safe place to drop real photos.

**macOS only:** image work uses the built-in `sips`, which is what keeps the
dependency count at zero. On Linux, swap the two `sips` calls in `prepareImage`
for ImageMagick.

### What the tool derives, and what you supply

Derived from each file: **width/height** (the original's dimensions, corrected for
EXIF orientation) and **timestamp** (EXIF `DateTimeOriginal` → Spotlight capture
date → file mtime, whichever lands first; the source is printed per photo).

Note `sips` strips the EXIF orientation tag without rotating the pixels, so the
tool applies the rotation itself. Without that, portrait photos would reach the
model on their side.

Everything else has no honest source in a bare file, so it comes from a **sidecar**
in the photo folder — `metrics.json` or `metrics.csv`, whichever is present
(`.json` wins if both are). Fill it in to match what Vision would actually produce.

`metrics.json` — keyed by filename:

```json
{
  "IMG_0001.jpg": {
    "category": "people",
    "faceCount": 2,
    "faceQuality": 0.82,
    "largestFaceAreaRatio": 0.31,
    "clusterID": "cluster_a"
  },
  "IMG_0002.jpg": {
    "category": "place",
    "faceCount": 0,
    "faceQuality": 0.0,
    "largestFaceAreaRatio": 0.0,
    "clusterID": "cluster_b"
  }
}
```

`metrics.csv` — one row per photo, header required:

```csv
filename,category,faceCount,faceQuality,largestFaceAreaRatio,clusterID
IMG_0001.jpg,people,2,0.82,0.31,cluster_a
IMG_0002.jpg,place,0,0,0,cluster_b
```

Any photo missing from the sidecar — or any individual field left blank — falls
back to a clearly-marked neutral default (`category: "unknown"`, the three face
numbers `0`, and a **unique** `clusterID` per photo, so absent data never reads as
"these are all near-duplicates"). The tool prints a warning naming exactly which
photos and fields got defaults, and marks them `DEFAULT` or `sidecar*` in the
prep table. With no sidecar at all it says so plainly: face-aware prompt
behaviour is not being exercised.

## Test it

Two photos, golden hour, basic tier. Replace the host with your deployment URL.
Two photos is below the 4-photo floor, so expect `insufficientStrongPhotos: true` —
and with placeholder pixels, quite possibly an empty `carousel`. Both are a `200`,
and the body is the model's raw JSON, so this doubles as a way to see exactly what
the model returned.

```bash
curl -sS -X POST https://YOUR-DEPLOYMENT.vercel.app/api/curate -H 'Content-Type: application/json' -d '{"photos":[{"id":"photo_001","thumbnail":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","metrics":{"category":"people","faceCount":2,"faceQuality":0.82,"largestFaceAreaRatio":0.31,"clusterID":"cluster_a","timestamp":"2026-08-17T18:04:11Z","width":3024,"height":4032}},{"id":"photo_002","thumbnail":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","metrics":{"category":"place","faceCount":0,"faceQuality":0.0,"largestFaceAreaRatio":0.0,"clusterID":"cluster_b","timestamp":"2026-08-17T18:06:40Z","width":4032,"height":3024}}],"tier":"basic","vibePack":"golden_hour"}'
```

Swap `"vibePack"` and `"tier"` to exercise the other five prompts.

Check the failure paths too:

```bash
curl -sS -i https://YOUR-DEPLOYMENT.vercel.app/api/curate
```

```bash
curl -sS -X POST https://YOUR-DEPLOYMENT.vercel.app/api/curate -H 'Content-Type: application/json' -d '{"photos":[],"tier":"gold","vibePack":"golden-hour"}'
```

## App Attest — investigated, not built

**The real defense.** IP rate limiting (above) falls to anyone behind a
shared/rotating proxy, and any secret embedded in the shipped IPA can be
extracted and replayed from anywhere else. App Attest is the one mechanism
that actually proves a request came from the genuine duvro binary running
on genuine Apple hardware, cryptographically, not by anything an attacker
could read out of the app bundle.

**Verdict up front: this is a real multi-day project, not a session.** The
crypto verification alone (below) has no Node stdlib shortcut for one of
its two parts, the storage is a new external dependency this repo doesn't
have today, and there's no lighter-weight option that gets "most" of the
benefit — every cheaper alternative either doesn't survive IPA extraction
or doesn't prove app identity at all. None of what follows is implemented;
this section exists so that project can be scoped confidently later.

### The full flow

**Once per device — attestation:**
1. App calls `DCAppAttestService.shared.generateKey()`. The Secure Enclave
   generates an ES256 (ECDSA P-256) key pair it never exposes; the app
   gets back an opaque `keyId` string.
2. App calls `attestKey(keyId, clientDataHash:)`, where `clientDataHash` is
   SHA-256 of a server-issued one-time challenge. This is the one call
   that talks to Apple's servers — it returns a CBOR **attestation
   object**: an X.509 certificate chain for the key (`attStmt.x5c`) plus
   `authenticatorData` (RP ID hash, a counter, an AAGUID, the credential
   ID).
3. App sends the attestation object + the `keyId` to our server, once.
4. **Server verifies, on this first call only:**
   - `x5c` chains to Apple's App Attest root CA (pinned, not just "any
     valid cert") — signatures, validity period, basic constraints.
   - A nonce computed as `SHA256(authenticatorData ‖ clientDataHash)`
     matches the value embedded in a specific `credCert` extension (OID
     `1.2.840.113635.100.8.2`) — this is what ties the certificate to
     *our* challenge, not a replayed one from elsewhere.
   - `authenticatorData`'s RP ID hash = `SHA256(TeamID + "." + BundleID)`
     — this app, not some other app on the same device.
   - `authenticatorData`'s counter = **0** (only true at first attestation).
   - `authenticatorData`'s AAGUID = `appattestdevelop` (dev) or `appattest`
     + seven `0x00` bytes (production).
   - `authenticatorData`'s credential ID = the `keyId` the app sent.
   - On success: **store `keyId → { publicKey, counter: 0 }`** (extracted
     from the verified cert). This record is the entire point of the
     storage requirement below.

**Every subsequent call — assertion (cheap, no Apple network round-trip):**
1. App calls `generateAssertion(keyId, clientDataHash:)`. Recommended
   `clientData` here is a hash of **the actual request body about to be
   sent** (the photos+metrics JSON), not a separately-fetched server
   nonce — Apple's own guidance allows this, and it avoids a second round
   trip per curation call for no security cost, since every request body
   already differs. This is a local Secure Enclave sign — no network call
   to Apple at all.
2. App sends `{ assertion, keyId, requestBody }` (the assertion rides
   alongside the normal curation payload, doesn't replace it).
3. **Server verifies, on every call:**
   - Recomputes `clientDataHash` from the received request body.
   - Recomputes `nonce = SHA256(authenticatorData ‖ clientDataHash)`.
   - Verifies the ES256 signature over `nonce` using the **public key
     stored at attestation time** for this `keyId`.
   - Re-checks the RP ID hash.
   - Verifies `authenticatorData`'s counter **strictly increased** since
     the last value stored for this `keyId`, then stores the new value.
     This is the replay/cloning defense: a captured-and-replayed
     assertion reuses the same counter value and is rejected; a cloned
     Secure Enclave (not possible in practice, but the threat model
     assumes it) would race two divergent counters and get caught the
     first time either one repeats.

### Storage

The server must persist, per device: `keyId` (string, primary key),
`publicKey` (the verified P-256 public key, ~65–91 bytes), `counter`
(integer). No TTL needed — a device's attestation is valid for the life
of that install, not a session.

**Vercel functions are stateless — `@vercel/kv` no longer exists as a
product.** The current path (confirmed against Vercel's own storage
guidance) is **Upstash Redis via the Vercel Marketplace**
(`vercel integration add upstash`, then `@upstash/redis` — auto-provisions
and injects env vars into the project). This is the same category of store
the rate-limiting section above would need for an in-function counter, if
that were ever built instead of the WAF rule.

**Free tier (Upstash, confirmed against their current pricing, not
assumed):** 256 MB storage, 500K commands/month, 10 GB bandwidth/month, up
to 10 databases, 10,000 commands/sec burst. A device record is a few
hundred bytes and costs 2 Redis ops per curation call (one `GET` to fetch
the stored key+counter, one `SET` to persist the new counter) — even at
thousands of daily active devices, this stays well inside the free tier;
storage alone would hold low hundreds of thousands of device records
before approaching 256 MB. Cost is not the blocker here — the
implementation work is.

### What the iOS app needs

- Add the **App Attest** capability in Xcode (Signing & Capabilities → +
  Capability). This is a standard managed capability — Xcode writes the
  `com.apple.developer.devicecheck.appattest-environment` entitlement
  (`development` or `production`, matching the build config) and no
  further Apple approval process is required beyond the existing paid
  Developer Program membership duvro already has. Not gated behind a
  special capability request the way some entitlements are.
- `DCAppAttestService` calls: `generateKey()` once at first launch (or
  first curation attempt), `attestKey()` once per device (send the
  challenge/attestation round trip to our server), then
  `generateAssertion()` on every curation call. `keyId` persists in the
  Keychain, not `UserDefaults` (survives reinstall the same way other
  Keychain-stored state would, which may or may not be desired — worth a
  deliberate decision, not a default).
- iOS 14+ requirement, comfortably covered by duvro's iOS 18 minimum.

### Latency

**No meaningful latency added to the curation call itself, if staged
correctly.** The two operations differ enormously:
- `generateKey()` + `attestKey()` (once per device) do talk to Apple's
  servers and are the "slow" part — real-world reports put this at
  roughly 1–3 seconds, sometimes more on a cold network. This should run
  **proactively, off the critical path** — e.g., during import or vibe-pack
  browsing, the same pattern `CurationService.prewarmCellularPermission()`
  already uses for the cellular-permission dialog — never synchronously
  blocking the first real curation attempt.
- `generateAssertion()` (every call) is a **local Secure Enclave sign, no
  network round-trip to Apple at all** — sub-100ms in practice. Server-side
  verification is a hash, one ECDSA signature check, and two Redis ops —
  all comfortably under 10ms combined. Against a call that already takes
  20–60s end to end, this is noise.

The only way this adds real latency is doing the one-time attestation
synchronously inside the curation request path instead of ahead of time —
worth calling out explicitly as the mistake to avoid, not a risk in the
mechanism itself.

### Is there a lighter-weight option?

**Honestly: no, not one that gets "most" of the actual benefit.** Every
cheaper alternative considered either fails the exact threat this is
meant to stop (extraction from the shipped IPA) or proves a different,
weaker thing:

- **A static embedded token or client-cert pin** — already the thing this
  is explicitly replacing; extractable from the IPA like any other
  embedded secret, no better than what exists today.
- **DeviceCheck** (`DCDevice.current.generateToken()`, App Attest's older,
  simpler sibling) — genuinely lighter (no key generation/attestation
  ceremony, just a persistent 2-bit per-device flag Apple stores for you)
  but proves a different thing: "this is a genuine Apple device," not
  "this specific request came from this specific genuine app binary." It
  has no per-request signature and doesn't verify app integrity at all —
  it's the right tool for "has this device already used its free tier"
  (already the plan for a future paid tier, per CLAUDE.md), not for
  authenticating the curation endpoint.
- **Rate limiting + the spend cap** (this session) are real and worth
  having regardless, but they bound *damage*, not *authenticity* — they
  don't stop a request that's shaped exactly like a real one, at a rate
  under the limit.

The one thing that IS optional, not fundamental: keeping this at **zero
runtime dependencies** specifically. Node's `crypto` module (`X509Certificate`)
can walk and verify the certificate chain without a new dependency, but
there's no built-in CBOR decoder — the attestation object's CBOR structure
is small and fixed (a map of `fmt`/`attStmt`/`authData`), so a
purpose-built minimal reader is realistic without a full CBOR library, but
it's still code to write and get right. Accepting one or two small,
well-maintained dependencies (a CBOR parser, possibly a verification
library — several exist on npm for App Attest specifically) would cut
real implementation time at the cost of the dependency-count invariant
this repo currently holds. That trade should be made deliberately when
this is actually scheduled, not decided here.

### Recommended sequencing (not a technical alternative — a priority call)

Given the real cost above, ship rate limiting + the spend cap now (this
session), and treat App Attest as its own scoped project once real
traffic volume makes the residual risk (a static-token-equivalent bypass,
or IP-limit evasion via rotating proxies) worth the implementation cost —
not before. This is a sequencing recommendation, not a claim that the risk
is fully covered in the meantime.
