# duvro-api

Server-side curation endpoint for duvro (iOS). Separate repo from the app.

**Status: skeleton.** There is no Claude API call yet — `/api/curate` validates
the payload, checks that `ANTHROPIC_API_KEY` is wired, and returns a hardcoded
selection built from the request. This exists to test the plumbing.

Zero runtime dependencies.

## Privacy invariants

These hold in the skeleton and must keep holding once the real call lands:

- The request body is **never logged**, echoed back, or written to disk. The
  payload contains user photos.
- `ANTHROPIC_API_KEY` is read from `process.env` only. It is never logged,
  never written to a file, and never included in a response.
- Validation errors name field **paths** (`photos[2].metrics.faceCount`), never
  field **values**.

## Endpoint

### `POST /api/curate`

Any other method returns `405`.

**Request body**

```jsonc
{
  "photos": [
    {
      "id": "string, unique within the request",
      "thumbnail": "base64 string (contents are not inspected)",
      "metrics": {
        "category": "string",
        "faceCount": 0,          // integer >= 0
        "faceQuality": 0.0,      // any finite number; not range-checked
        "clusterID": "string or number",
        "timestamp": "ISO 8601 string or numeric epoch"
      }
    }
  ],
  "count": 1,                    // integer >= 1, <= photos.length
  "vibePack": "string"
}
```

At most 500 photos per request.

**Responses**

| Status | When |
| --- | --- |
| `200` | Valid payload. Returns the stub selection. |
| `400` | Body isn't valid JSON, or fails shape validation. `details` lists the offending field paths. |
| `405` | Method is not `POST`. |
| `500` | `ANTHROPIC_API_KEY` is not set in the environment. |

**200 body (stub)**

```json
{
  "selection": ["photo_001"],
  "runnerUps": ["photo_002"],
  "vibePack": "golden-hour",
  "stub": true
}
```

`selection` is the first `count` photo ids in request order. `runnerUps` is the
next 3 ids after those (fewer if the request doesn't have that many). The
`"stub": true` flag disappears once the real Claude call replaces the hardcoded
block in [api/curate.js](api/curate.js).

## Setup

Set the key in the Vercel project (Settings → Environment Variables), or for
local `vercel dev`, copy [.env.example](.env.example) to `.env.local` and fill
it in. `.env*` is gitignored.

Deploy with `vercel` — this repo does not deploy itself.

## Test it

Two photos, count of 1. Replace the host with your deployment URL.

```bash
curl -sS -X POST https://YOUR-DEPLOYMENT.vercel.app/api/curate -H 'Content-Type: application/json' -d '{"photos":[{"id":"photo_001","thumbnail":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","metrics":{"category":"portrait","faceCount":2,"faceQuality":0.82,"clusterID":"cluster_a","timestamp":"2026-08-17T18:04:11Z"}},{"id":"photo_002","thumbnail":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","metrics":{"category":"landscape","faceCount":0,"faceQuality":0.0,"clusterID":"cluster_b","timestamp":"2026-08-17T18:06:40Z"}}],"count":1,"vibePack":"golden-hour"}'
```

Expected:

```json
{"selection":["photo_001"],"runnerUps":["photo_002"],"vibePack":"golden-hour","stub":true}
```

Check the failure paths too:

```bash
curl -sS -i https://YOUR-DEPLOYMENT.vercel.app/api/curate
```

```bash
curl -sS -X POST https://YOUR-DEPLOYMENT.vercel.app/api/curate -H 'Content-Type: application/json' -d '{"photos":[],"count":1}'
```
