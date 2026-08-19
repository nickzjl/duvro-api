# duvro-api

Server-side curation endpoint for duvro (iOS). Separate repo from the app.

`POST /api/curate` takes a batch of camera-roll photos, sends them to Claude with
the system prompt for the requested aesthetic and tier, and returns the model's
carousel selection, alternates, and captions.

Zero runtime dependencies (Node's built-in `fetch`).

## Privacy invariants

- The request body is **never logged**, echoed, or written to disk. Neither is
  the model's response — it describes the user's photos. There is no `console.*`
  call and no filesystem write anywhere in `api/` or `lib/`.
- `ANTHROPIC_API_KEY` is read from `process.env` only. It is never logged, never
  written to a file, and never included in a response. Anthropic error bodies are
  drained and discarded rather than forwarded, since they can quote request content.
- Validation errors name field **paths** (`photos[2].metrics.width`), never
  field **values**.

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

### Enabling prompt caching

All six prompts are 2,700–4,700 tokens, well above Sonnet 4.6's 1,024-token
minimum, and the system prompt is the stable prefix. To turn caching on, add one
field in [api/curate.js](api/curate.js):

```js
system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
```

Cache reads cost ~0.1× and writes ~1.25×, so this pays off from the second request
with the same pack+tier inside the 5-minute TTL. It is left off for now.

## Setup

Set `ANTHROPIC_API_KEY` in the Vercel project (Settings → Environment Variables),
or for local `vercel dev`, copy [.env.example](.env.example) to `.env.local` and
fill it in. `.env*` is gitignored.

Deploy with `vercel` — this repo does not deploy itself.

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
