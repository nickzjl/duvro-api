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

Verify hits are actually landing via `usage.cache_read_input_tokens` in the
Anthropic response (not logged — see Privacy invariants above; check it
manually against a raw response during testing, not in production).

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
