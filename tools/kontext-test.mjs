#!/usr/bin/env node
/**
 * Local dev tool — NOT part of the deployed function (see .vercelignore).
 *
 * Runs the REAL fal path end to end for one or more (variant, guidance) pairs:
 *
 *   1. POST {restHost}/storage/upload/initiate   (via lib/falStorage.js — the
 *                                                 shipped code, so this test
 *                                                 actually exercises it)
 *   2. PUT the raw bytes to the returned signed URL, with no credentials
 *   3. POST https://queue.fal.run/fal-ai/flux-pro/kontext against file_url
 *   4. poll status, fetch the result, download the image
 *
 * Deliberately NOT shortcut with a data URI: proving the upload leg works is
 * half the point.
 *
 * THIS SPENDS MONEY — roughly $0.04 per generation. The run is capped
 * (--max-generations, default 8) and every run prints its cost estimate first.
 *
 * Settings follow docs (KONTEXT_API_SETTINGS_AND_TEST_PLAN): enhance_prompt
 * false, num_images 1, output_format png, safety_tolerance "2" (a MODERATION
 * control, not a fidelity control), aspect_ratio UNSET so source framing is
 * preserved, seed fixed across the sweep. Only guidance_scale varies.
 *
 *   node tools/kontext-test.mjs test-photos/g3.JPG \
 *     --variant "digicam/Light Leak" --guidance 2.0,2.5,3.0,3.5
 *
 * Writes nothing to the repo except the output directory, which is gitignored.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { getFalConfig, authHeaders, outputLifecycleHeaders, classifyFalError } from '../lib/fal.js';
import { initiateUpload } from '../lib/falStorage.js';
import { loadStyleInstruction, isPlaceholder, PACK_VARIANTS, canonicalVariant } from '../lib/styles.js';

const run = promisify(execFile);

const COST_PER_GENERATION_USD = 0.04;
const DEFAULT_MAX_GENERATIONS = 8;
const DEFAULT_SEED = 20260830;
const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 3000;
const POLL_BACKOFF = 1.35;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {
    image: null, variants: [], guidances: [], seed: DEFAULT_SEED,
    outDir: 'kontext-out', maxGenerations: DEFAULT_MAX_GENERATIONS, dryRun: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--variant') o.variants.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--guidance') o.guidances.push(...argv[++i].split(',').map((s) => Number(s.trim())));
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--max-generations') o.maxGenerations = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.image = rest[0] ?? null;
  return o;
}

const USAGE = `
Usage:
  node tools/kontext-test.mjs <image> --variant "<pack>/<Variant>" --guidance <n>[,<n>...]

  --variant           e.g. "digicam/Light Leak". Repeatable or comma-separated.
  --guidance          e.g. 2.0,2.5,3.0,3.5
  --seed              fixed across the sweep (default ${DEFAULT_SEED})
  --out-dir           default kontext-out/ (gitignored)
  --max-generations   hard spend cap (default ${DEFAULT_MAX_GENERATIONS} = $${(DEFAULT_MAX_GENERATIONS * COST_PER_GENERATION_USD).toFixed(2)})
  --dry-run           resolve everything, print the plan, spend nothing
`;

/** Resolve "digicam/Light Leak" to a canonical (pack, variant) pair. */
function resolveVariant(spec) {
  const [packRaw, ...rest] = spec.split('/');
  const pack = packRaw.trim();
  const variantRaw = rest.join('/').trim();
  if (!Object.hasOwn(PACK_VARIANTS, pack)) {
    throw new Error(`unknown pack "${pack}" (expected one of ${Object.keys(PACK_VARIANTS).join(', ')})`);
  }
  const variant = canonicalVariant(pack, variantRaw);
  if (!variant) {
    throw new Error(`unknown variant "${variantRaw}" for ${pack} (expected one of ${PACK_VARIANTS[pack].join(', ')})`);
  }
  return { pack, variant };
}

/** fal accepts jpeg/png/webp; HEIC is converted first so the test is about fal, not format support. */
async function readSource(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (CONTENT_TYPES[ext]) {
    return { bytes: await readFile(imagePath), contentType: CONTENT_TYPES[ext], converted: false };
  }
  const tmp = path.join('/tmp', `kontext-src-${Date.now()}.jpg`);
  await run('sips', ['-s', 'format', 'jpeg', imagePath, '--out', tmp]);
  return { bytes: await readFile(tmp), contentType: 'image/jpeg', converted: true };
}

async function dimensions(file) {
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = stdout.match(/pixelWidth:\s*(\d+)/)?.[1];
    const h = stdout.match(/pixelHeight:\s*(\d+)/)?.[1];
    return w && h ? `${w}x${h}` : '?';
  } catch { return '?'; }
}

const ms = (t) => `${(Number(t) / 1e6).toFixed(0)}ms`;
const now = () => process.hrtime.bigint();

/* ------------------------------------------------------------------ */

async function uploadOnce({ config, bytes, contentType, fileName }) {
  const tInit = now();
  const { uploadUrl, fileUrl } = await initiateUpload({ contentType, fileName }, { config });
  const initiateMs = now() - tInit;

  // The gap fal documents nothing about: how long a signed URL stays valid.
  const tPut = now();
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },   // NO Authorization — that is the point
    body: bytes,
  });
  const putMs = now() - tPut;
  const putBody = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`PUT to signed URL failed: HTTP ${res.status} ${putBody.slice(0, 300)}`);
  }
  return {
    uploadUrl, fileUrl, initiateMs, putMs,
    mintToPutCompleteMs: initiateMs + putMs,
    putStatus: res.status,
  };
}

async function generateOnce({ config, imageUrl, prompt, guidance, seed }) {
  const submitUrl = `${config.queueHost}/${config.model}`;
  const body = {
    prompt,
    image_url: imageUrl,
    guidance_scale: guidance,
    seed,
    num_images: 1,
    output_format: 'png',
    enhance_prompt: false,
    safety_tolerance: '2',
    sync_mode: false,
    // aspect_ratio deliberately UNSET — see the settings doc.
  };

  const tSubmit = now();
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: { ...authHeaders(config), ...outputLifecycleHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const submitText = await submitRes.text();
  const submitMs = now() - tSubmit;

  if (!submitRes.ok) {
    const c = classifyFalError(submitRes.status, submitRes.headers, submitText);
    throw new Error(`submit HTTP ${submitRes.status} (${c.code}, retryable=${c.retryable}): ${submitText.slice(0, 400)}`);
  }
  const submitted = JSON.parse(submitText);

  const tPoll = now();
  let waitMs = POLL_INITIAL_MS;
  let polls = 0;
  let lastStatus = null;
  // Separating queue wait from inference is the only way to read a slow call:
  // 145s of queueing and 145s of generating mean completely different things
  // for the production timeout.
  let firstInProgressAt = null;
  let metrics = null;
  let seenStatuses = [];
  const statusUrl = submitted.status_url ?? `${submitUrl}/requests/${submitted.request_id}/status`;
  const responseUrl = submitted.response_url ?? `${submitUrl}/requests/${submitted.request_id}`;

  for (;;) {
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs = Math.min(Math.round(waitMs * POLL_BACKOFF), POLL_MAX_MS);
    polls += 1;

    const sRes = await fetch(statusUrl, { headers: authHeaders(config) });
    const sText = await sRes.text();
    if (!sRes.ok) {
      if (sRes.status === 404) continue;
      throw new Error(`status HTTP ${sRes.status}: ${sText.slice(0, 300)}`);
    }
    const s = JSON.parse(sText);
    lastStatus = s.status;
    if (seenStatuses[seenStatuses.length - 1] !== s.status) seenStatuses.push(s.status);
    if (s.status === 'IN_PROGRESS' && firstInProgressAt === null) firstInProgressAt = now();
    if (s.status === 'COMPLETED') {
      if (s.error || s.error_type) {
        throw new Error(`generation failed: error_type=${s.error_type} error=${JSON.stringify(s.error).slice(0, 300)}`);
      }
      metrics = s.metrics ?? null;
      break;
    }
    if (s.status !== 'IN_QUEUE' && s.status !== 'IN_PROGRESS') {
      throw new Error(`unexpected status "${s.status}"`);
    }
  }

  const rRes = await fetch(responseUrl, { headers: authHeaders(config) });
  const rText = await rRes.text();
  if (!rRes.ok) throw new Error(`result HTTP ${rRes.status}: ${rText.slice(0, 300)}`);
  const result = JSON.parse(rText);
  const generateMs = now() - tSubmit;

  return {
    submitted, result, submitMs, pollMs: now() - tPoll, generateMs, polls, lastStatus,
    requestBody: body, metrics, seenStatuses,
    queueMs: firstInProgressAt === null ? null : firstInProgressAt - tPoll,
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.image) { console.log(USAGE); process.exit(opts.help ? 0 : 1); }
  if (opts.variants.length === 0 || opts.guidances.length === 0) {
    console.error('Error: --variant and --guidance are both required.\n' + USAGE);
    process.exit(1);
  }
  if (opts.guidances.some((g) => !Number.isFinite(g))) {
    console.error('Error: --guidance must be numbers.'); process.exit(1);
  }

  let config;
  try {
    config = getFalConfig();
  } catch (err) {
    console.error(`\n  ${err.message}\n  Set FAL_KEY in the environment before running.\n`);
    process.exit(1);
  }

  const pairs = [];
  for (const spec of opts.variants) {
    const { pack, variant } = resolveVariant(spec);
    const instruction = loadStyleInstruction(pack, variant);
    for (const g of opts.guidances) pairs.push({ pack, variant, instruction, guidance: g });
  }

  const cost = pairs.length * COST_PER_GENERATION_USD;
  const srcStat = await stat(opts.image);
  const srcDims = await dimensions(opts.image);

  console.log(`\n  Source      ${opts.image}  ${srcDims}  ${(srcStat.size / 1024).toFixed(0)} KB`);
  console.log(`  Seed        ${opts.seed} (fixed across the sweep)`);
  console.log(`  Constant    enhance_prompt=false  num_images=1  output_format=png  safety_tolerance="2"  aspect_ratio=UNSET`);
  console.log(`  Varying     guidance_scale ${opts.guidances.join(', ')}`);
  console.log(`  Variants    ${opts.variants.join(' | ')}`);
  for (const spec of opts.variants) {
    const { pack, variant } = resolveVariant(spec);
    const inst = loadStyleInstruction(pack, variant);
    console.log(`                ${(pack + '/' + variant).padEnd(28)} ${inst.length} chars${isPlaceholder(inst) ? '  ⚠ PLACEHOLDER' : ''}`);
  }
  console.log(`\n  ${pairs.length} generations  ≈ $${cost.toFixed(2)}  (cap ${opts.maxGenerations} = $${(opts.maxGenerations * COST_PER_GENERATION_USD).toFixed(2)})\n`);

  if (pairs.length > opts.maxGenerations) {
    console.error(`  REFUSING: ${pairs.length} generations exceeds the cap of ${opts.maxGenerations}.`);
    console.error(`  Raise it deliberately with --max-generations if that is what you want.\n`);
    process.exit(1);
  }
  if (opts.dryRun) { console.log('  --dry-run: nothing sent, nothing spent.\n'); return; }

  await mkdir(opts.outDir, { recursive: true });

  // Upload ONCE and reuse the file_url across every generation — which is the
  // production pattern too (one photo feeds three variants).
  const src = await readSource(opts.image);
  console.log(`  Uploading ${(src.bytes.length / 1024).toFixed(0)} KB as ${src.contentType}${src.converted ? ' (converted from HEIC)' : ''}…`);

  let up;
  try {
    up = await uploadOnce({
      config, bytes: src.bytes, contentType: src.contentType,
      fileName: path.basename(opts.image),
    });
  } catch (err) {
    console.error(`\n  UPLOAD FAILED: ${err.message}\n  Stopping before any generation was attempted.\n`);
    process.exit(1);
  }

  console.log(`  initiate    ${ms(up.initiateMs)}`);
  console.log(`  PUT         ${ms(up.putMs)}  HTTP ${up.putStatus}`);
  console.log(`  mint→PUT    ${ms(up.mintToPutCompleteMs)}  (fal documents no validity window for the signed URL)`);
  console.log(`  file host   ${new URL(up.fileUrl).host}`);
  console.log();

  const rows = [];
  for (const [i, pair] of pairs.entries()) {
    const label = `${pair.pack}/${pair.variant} @ g${pair.guidance}`;
    process.stdout.write(`  [${i + 1}/${pairs.length}] ${label.padEnd(38)} `);

    let gen;
    try {
      gen = await generateOnce({
        config, imageUrl: up.fileUrl, prompt: pair.instruction,
        guidance: pair.guidance, seed: opts.seed,
      });
    } catch (err) {
      console.log('FAILED');
      console.error(`\n  ${err.message}`);
      console.error(`\n  Stopping after ${i} successful generation(s) rather than running the rest.\n`);
      process.exit(1);
    }

    const img = gen.result?.images?.[0];
    const outUrl = img?.url;
    if (!outUrl) {
      console.log('NO IMAGE');
      console.error(`\n  result had no images[0].url. Full response:\n${JSON.stringify(gen.result, null, 2)}\n`);
      process.exit(1);
    }

    const dl = await fetch(outUrl);
    const buf = Buffer.from(await dl.arrayBuffer());
    const slug = `${pair.pack}.${pair.variant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    // The SOURCE must be in the filename. Without it a second run on a
    // different photo at the same (variant, guidance, seed) silently
    // overwrites the first — which is exactly what happened the first time
    // this tool was used, destroying one of eight sweep outputs.
    const srcStem = path.basename(opts.image).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9]+/g, '-');
    const file = path.join(opts.outDir, `${srcStem}__${slug}__g${pair.guidance}__seed${opts.seed}.png`);
    await writeFile(file, buf);

    const infer = gen.metrics?.inference_time;
    const detail = [
      gen.queueMs === null ? 'queue<1poll' : `queue~${ms(gen.queueMs)}`,
      infer != null ? `infer ${(infer).toFixed(1)}s` : 'infer n/a',
      gen.seenStatuses.join('>'),
    ].join('  ');
    console.log(`${ms(gen.generateMs).padStart(8)}  ${img.width}x${img.height}  ${(buf.length / 1024).toFixed(0)} KB  ${detail}`);
    console.log(`${' '.repeat(52)}-> ${file}`);

    rows.push({
      label, guidance: pair.guidance, gen, img, file,
      outHost: new URL(outUrl).host, bytes: buf.length,
    });

    if (i === 0) {
      console.log('\n  ── First response, verbatim ' + '─'.repeat(44));
      console.log('  request body:');
      console.log(JSON.stringify(gen.requestBody, null, 2).split('\n').map((l) => '    ' + l).join('\n').replace(/("prompt": ").{80,}?(")/, '$1<instruction, ' + pair.instruction.length + ' chars>$2'));
      console.log('  submit response:');
      console.log(JSON.stringify(gen.submitted, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
      console.log('  result response:');
      console.log(JSON.stringify(gen.result, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
      console.log('  ' + '─'.repeat(70) + '\n');
    }
  }

  console.log('\n  ── Summary ' + '─'.repeat(60));
  console.log(`  source ${srcDims}   output ${rows[0]?.img.width}x${rows[0]?.img.height}   ` +
    `${srcDims === `${rows[0]?.img.width}x${rows[0]?.img.height}` ? 'framing PRESERVED' : 'FRAMING CHANGED — aspect_ratio behaviour differs from expectation'}`);
  console.log(`  output host(s): ${[...new Set(rows.map((r) => r.outHost))].join(', ')}`);
  console.log(`  latency: ${rows.map((r) => ms(r.gen.generateMs)).join(', ')}`);
  console.log(`  polls per generation: ${rows.map((r) => r.gen.polls).join(', ')}`);
  console.log(`  spent ≈ $${(rows.length * COST_PER_GENERATION_USD).toFixed(2)} on ${rows.length} generations`);
  console.log(`  outputs in ${opts.outDir}/\n`);
}

main().catch((err) => { console.error(`\n  ${err.message}\n`); process.exit(1); });
