#!/usr/bin/env node
/**
 * Local dev tool — NOT part of the deployed function (see .vercelignore).
 *
 * Sends a folder of real photos through the deployed /api/curate endpoint so
 * the prompts can be evaluated against real images instead of test pixels.
 *
 *   node tools/curate-test.mjs <folder> --pack golden_hour --tier basic \
 *        --url https://your-deployment.vercel.app
 *
 * Zero npm dependencies. Image work uses macOS's built-in `sips`, so this
 * script is macOS-only; on Linux swap the two `sips` calls in `prepareImage`
 * for ImageMagick (`magick`).
 *
 * Writes nothing to the repo. Resized thumbnails go to a temp dir and are
 * deleted on exit. Base64 content and the response body are printed to stdout
 * only — never written to a file.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff',
]);

const SIDECAR_FIELDS = [
  'category', 'faceCount', 'faceQuality', 'largestFaceAreaRatio', 'clusterID',
];

// Neutral, obviously-synthetic defaults for metrics that can't be derived from
// a file. clusterID is unique per photo on purpose: a shared default would
// falsely tell the model every photo is a near-duplicate of every other.
const defaultMetrics = (i) => ({
  category: 'unknown',
  faceCount: 0,
  faceQuality: 0,
  largestFaceAreaRatio: 0,
  clusterID: `nocluster_${String(i + 1).padStart(2, '0')}`,
});

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    folder: null, pack: null, tier: null,
    url: process.env.DUVRO_API_URL ?? null,
    maxDim: 512, quality: 70, dryRun: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack' || a === '--vibePack') opts.pack = argv[++i];
    else if (a === '--tier') opts.tier = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--max-dim') opts.maxDim = Number(argv[++i]);
    else if (a === '--quality') opts.quality = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  opts.folder = rest[0] ?? null;
  return opts;
}

const USAGE = `
Usage:
  node tools/curate-test.mjs <folder> --pack <pack> --tier <tier> [--url <url>]

Required:
  <folder>          Directory of images to send
  --pack            golden_hour | digicam | travel_film
  --tier            basic | premium
  --url             Deployment base URL (or set DUVRO_API_URL)

Optional:
  --max-dim <px>    Long-edge size for the downsampled thumbnail (default 512)
  --quality <1-100> JPEG quality for the thumbnail (default 70)
  --dry-run         Build and report the payload without POSTing

Sidecar (optional, in <folder>): metrics.json or metrics.csv supplying the
metrics that cannot be derived from a file. See the README.
`;

/* ------------------------------------------------------------------ */
/* EXIF                                                                */
/* ------------------------------------------------------------------ */

/**
 * Minimal EXIF reader: pulls Orientation (0x0112) and DateTimeOriginal
 * (0x9003) out of a JPEG's APP1 segment. Returns {} for anything else.
 * Hand-rolled to keep the dependency count at zero — `sips -g all` does not
 * expose either field.
 */
function readExif(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return {};

  let i = 2, app1 = -1;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) break;      // start of scan / end
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      app1 = i + 10;
      break;
    }
    i += 2 + len;
  }
  if (app1 < 0 || app1 + 8 > buf.length) return {};

  const le = buf.subarray(app1, app1 + 2).toString('latin1') === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const out = {};
  const walk = (ifdOff, depth) => {
    if (depth > 2 || ifdOff + 2 > buf.length) return;
    const n = u16(ifdOff);
    if (n > 512) return;                                 // junk guard
    for (let e = 0; e < n; e++) {
      const off = ifdOff + 2 + e * 12;
      if (off + 12 > buf.length) return;
      const tag = u16(off);
      if (tag === 0x0112) {
        const v = u16(off + 8);
        if (v >= 1 && v <= 8) out.orientation = v;
      } else if (tag === 0x8769) {
        walk(app1 + u32(off + 8), depth + 1);            // ExifIFD
      } else if (tag === 0x9003) {
        const p = app1 + u32(off + 8);
        if (p + 19 <= buf.length) {
          const s = buf.subarray(p, p + 19).toString('latin1');
          // "YYYY:MM:DD HH:MM:SS" -> ISO 8601 (local, no zone in EXIF)
          const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
          if (m) out.dateTimeOriginal = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
        }
      }
    }
  };
  walk(app1 + u32(app1 + 4), 0);
  return out;
}

/** Spotlight fallback — works for HEIC and other non-JPEG originals. */
async function spotlightDate(file) {
  try {
    const { stdout } = await run('mdls', ['-raw', '-name', 'kMDItemContentCreationDate', file]);
    const s = stdout.trim();
    if (!s || s === '(null)') return null;
    const d = new Date(s.replace(' +0000', 'Z').replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Image prep                                                          */
/* ------------------------------------------------------------------ */

// EXIF orientation -> the sips passes that bake the rotation into the pixels.
// `sips -Z` silently DROPS the orientation tag without rotating, so without
// this every portrait photo would reach the model on its side.
const ORIENT_OPS = {
  1: [],
  2: [['-f', 'horizontal']],
  3: [['-r', '180']],
  4: [['-f', 'vertical']],
  5: [['-f', 'horizontal'], ['-r', '270']],
  6: [['-r', '90']],
  7: [['-f', 'horizontal'], ['-r', '90']],
  8: [['-r', '270']],
};

async function sipsDims(file) {
  const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const w = stdout.match(/pixelWidth:\s*(\d+)/);
  const h = stdout.match(/pixelHeight:\s*(\d+)/);
  return { width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null };
}

async function prepareImage(src, workDir, index, { maxDim, quality }) {
  const out = path.join(workDir, `t${index}.jpg`);

  // 1. downsample + normalise to JPEG
  await run('sips', [
    '-Z', String(maxDim),
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(quality),
    src, '--out', out,
  ]);

  // 2. bake in rotation, since sips dropped the tag
  const original = await readFile(src);
  const exif = readExif(original);
  const orientation = exif.orientation ?? 1;
  for (const op of ORIENT_OPS[orientation] ?? []) {
    await run('sips', [...op, out]);
  }

  // 3. dimensions: report the ORIGINAL photo, orientation-corrected — that is
  //    what the API contract means by "orientation-corrected pixel dimensions".
  const stored = await sipsDims(src);
  const swap = orientation >= 5 && orientation <= 8;
  const width = swap ? stored.height : stored.width;
  const height = swap ? stored.width : stored.height;

  // 4. timestamp: EXIF -> Spotlight -> file mtime, whichever lands first
  let timestamp = exif.dateTimeOriginal ?? null;
  let timestampSource = timestamp ? 'exif' : null;
  if (!timestamp) {
    timestamp = await spotlightDate(src);
    if (timestamp) timestampSource = 'spotlight';
  }
  if (!timestamp) {
    timestamp = (await stat(src)).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
    timestampSource = 'mtime';
  }

  const thumbBuf = await readFile(out);
  const thumbDims = await sipsDims(out);

  return {
    thumbnail: thumbBuf.toString('base64'),
    thumbBytes: thumbBuf.length,
    thumbDims,
    width, height, orientation, timestamp, timestampSource,
  };
}

/* ------------------------------------------------------------------ */
/* Sidecar                                                             */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return {};
  const head = lines[0].split(',').map((h) => h.trim());
  const out = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    const name = row.filename ?? row.file ?? row.name;
    if (!name) continue;
    out[name] = row;
  }
  return out;
}

function coerce(raw) {
  if (!raw) return null;
  const m = {};
  if (raw.category != null && String(raw.category).length) m.category = String(raw.category);
  for (const k of ['faceCount', 'faceQuality', 'largestFaceAreaRatio']) {
    if (raw[k] != null && String(raw[k]).length) {
      const n = Number(raw[k]);
      if (Number.isFinite(n)) m[k] = n;
    }
  }
  if (raw.clusterID != null && String(raw.clusterID).length) m.clusterID = String(raw.clusterID);
  return Object.keys(m).length ? m : null;
}

async function loadSidecar(folder) {
  for (const name of ['metrics.json', 'metrics.csv']) {
    const p = path.join(folder, name);
    try {
      const text = await readFile(p, 'utf8');
      const raw = name.endsWith('.json') ? JSON.parse(text) : parseCsv(text);
      return { file: name, entries: raw };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`could not read ${name}: ${err.message}`);
      }
    }
  }
  return { file: null, entries: {} };
}

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c ?? '', widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.folder) { console.log(USAGE); process.exit(opts.help ? 0 : 1); }
  const problems = [];
  if (!['golden_hour', 'digicam', 'travel_film'].includes(opts.pack)) {
    problems.push('--pack must be golden_hour, digicam, or travel_film');
  }
  if (!['basic', 'premium'].includes(opts.tier)) {
    problems.push('--tier must be basic or premium');
  }
  if (!opts.url && !opts.dryRun) {
    problems.push('--url (or DUVRO_API_URL) is required unless --dry-run');
  }
  if (problems.length) {
    console.error('Error:\n  ' + problems.join('\n  ') + '\n' + USAGE);
    process.exit(1);
  }

  const entries = await readdir(opts.folder, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.error(`No images found in ${opts.folder}`);
    process.exit(1);
  }
  if (files.length > 100) {
    console.error(`${files.length} images found; the endpoint accepts at most 100.`);
    process.exit(1);
  }

  const sidecar = await loadSidecar(opts.folder);

  const workDir = await mkdtemp(path.join(tmpdir(), 'duvro-curate-'));
  const photos = [];
  const byId = new Map();
  const defaulted = [];
  const partial = [];
  const prepRows = [];

  try {
    console.log(`\nPreparing ${files.length} image${files.length === 1 ? '' : 's'} ` +
                `(long edge ${opts.maxDim}px, JPEG q${opts.quality})…\n`);

    for (let i = 0; i < files.length; i++) {
      const name = files[i];
      const id = `p${String(i + 1).padStart(2, '0')}`;
      const prep = await prepareImage(path.join(opts.folder, name), workDir, i, opts);

      const supplied = coerce(sidecar.entries[name]);
      const missing = supplied
        ? SIDECAR_FIELDS.filter((f) => supplied[f] === undefined)
        : SIDECAR_FIELDS;
      if (!supplied) defaulted.push(name);
      else if (missing.length) partial.push(`${name} (${missing.join(', ')})`);

      const metrics = { ...defaultMetrics(i), ...(supplied ?? {}) };

      photos.push({
        id,
        thumbnail: prep.thumbnail,
        mediaType: 'image/jpeg',
        metrics: {
          category: metrics.category,
          faceCount: metrics.faceCount,
          faceQuality: metrics.faceQuality,
          largestFaceAreaRatio: metrics.largestFaceAreaRatio,
          clusterID: metrics.clusterID,
          timestamp: prep.timestamp,
          width: prep.width,
          height: prep.height,
        },
      });
      byId.set(id, name);
      prepRows.push([
        id, name,
        `${prep.thumbDims.width}x${prep.thumbDims.height}`,
        `${prep.width}x${prep.height}`,
        prep.orientation === 1 ? '-' : `rot${prep.orientation}`,
        `${prep.timestamp} (${prep.timestampSource})`,
        supplied ? (missing.length ? 'sidecar*' : 'sidecar') : 'DEFAULT',
      ]);
    }

    table(prepRows, ['id', 'file', 'thumb', 'orig(corrected)', 'exif', 'timestamp', 'metrics']);

    console.log();
    if (!sidecar.file) {
      console.log(`  !  No metrics.json or metrics.csv in ${opts.folder} —`);
      console.log(`     all ${files.length} photos are using neutral defaults`);
      console.log(`     (category "unknown", faceCount/faceQuality/largestFaceAreaRatio 0,`);
      console.log(`     unique clusterID per photo). Face-aware prompt behaviour is NOT`);
      console.log(`     being exercised.`);
    } else {
      console.log(`  Sidecar: ${sidecar.file}`);
      if (defaulted.length) {
        console.log(`  !  Not listed in the sidecar — using neutral defaults:`);
        for (const n of defaulted) console.log(`       ${n}`);
      }
      if (partial.length) {
        console.log(`  !  Listed but missing some fields (marked sidecar*) — defaults filled in:`);
        for (const n of partial) console.log(`       ${n}`);
      }
      if (!defaulted.length && !partial.length) {
        console.log(`  All ${files.length} photos have complete sidecar metrics.`);
      }
    }

    const payload = { photos, tier: opts.tier, vibePack: opts.pack };
    const bodyText = JSON.stringify(payload);
    const bytes = Buffer.byteLength(bodyText);

    console.log(`\n  Photos:        ${photos.length}`);
    console.log(`  Request size:  ${mb(bytes)} MB`);
    console.log(`  Pack / tier:   ${opts.pack} / ${opts.tier}`);

    if (opts.dryRun) {
      console.log('\n  --dry-run: payload built, nothing sent.\n');
      return;
    }

    const endpoint = new URL('/api/curate', opts.url).toString();
    console.log(`  POST:          ${endpoint}\n`);

    const started = process.hrtime.bigint();
    let res, text;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyText,
      });
      text = await res.text();
    } catch (err) {
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      console.error(`  Request failed after ${secs.toFixed(1)}s: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const secs = Number(process.hrtime.bigint() - started) / 1e9;

    console.log(`  HTTP ${res.status}   ${secs.toFixed(1)}s wall clock\n`);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.log(text);
      process.exitCode = 1;
      return;
    }

    if (!res.ok) {
      console.log('  Error response:');
      console.log(JSON.stringify(body, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
      console.log();
      process.exitCode = 1;
      return;
    }

    report(body, byId, secs);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function report(body, byId, secs) {
  const nameOf = (id) => byId.get(id) ?? `<UNKNOWN id ${id}>`;

  console.log('  ── Carousel ' + '─'.repeat(52));
  if (body.carousel.length === 0) {
    console.log('  (empty — model found nothing postable)');
  } else {
    table(
      body.carousel.map((c, i) => [String(i + 1), c.id, nameOf(c.id), c.role, c.selectionReason]),
      ['#', 'id', 'file', 'role', 'why'],
    );
  }

  console.log('\n  ── Alternates ' + '─'.repeat(50));
  if (!body.alternates?.length) {
    console.log('  (none)');
  } else {
    table(
      body.alternates.map((a) => [
        a.id, nameOf(a.id), a.type,
        a.replaceId ? `${a.replaceId} (${nameOf(a.replaceId)})` : '-',
        a.role, a.reason,
      ]),
      ['id', 'file', 'type', 'replaces', 'role', 'why'],
    );
  }

  console.log('\n  ── Captions ' + '─'.repeat(52));
  if (!body.captions?.length) console.log('  (none)');
  else for (const c of body.captions) console.log(`  ${c.rank}. ${c.text}`);

  console.log('\n  ── Summary ' + '─'.repeat(53));
  console.log(`  Carousel length chosen:    ${body.carousel.length}`);
  console.log(`  postConcept:               ${body.postConcept}`);
  console.log(`  selectedCount (model):     ${body.selectedCount}` +
    (body.selectedCount !== body.carousel.length
      ? `   <- disagrees with actual length ${body.carousel.length}` : ''));
  console.log(`  insufficientStrongPhotos:  ${body.insufficientStrongPhotos}`);
  console.log(`  alternates / captions:     ${body.alternates?.length ?? 0} / ${body.captions?.length ?? 0}`);
  console.log(`  Wall clock:                ${secs.toFixed(1)}s`);
  console.log();
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
