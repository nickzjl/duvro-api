/**
 * Loads the style instruction for a (vibePack, variant) pair from
 * prompts/styles/*.txt.
 *
 * Deliberately the same shape as lib/prompts.js, which loads the six curation
 * prompts: plain text files rather than string literals, so they can be edited
 * without touching code, read once per warm instance and cached in memory.
 *
 * EVERY INSTRUCTION IS CURRENTLY A PLACEHOLDER. Phrasing is model-specific and
 * no image model has been chosen, so each file states the look in plain terms
 * and carries a TODO. `isPlaceholder()` below reports that honestly rather
 * than letting placeholder text silently reach a real provider — the premium
 * endpoint surfaces it in DEBUG so "the look is wrong" is never confused with
 * "nobody wrote the instruction yet".
 *
 * The nine variants are the app's own, verbatim from duvro/Packs/*.json —
 * these names are the contract with the app, which sends EditVariant.name as
 * it appears there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * pack id -> the pack's three variant display names, in the pack's own order.
 * Order matters: the app pre-selects variants[0] on arrival and the showcase
 * leads with it (CurationSequenceView, EditFlowView).
 */
export const PACK_VARIANTS = {
  golden_hour: ['Sun-kissed', 'Warm Film', 'Soft Glow'],
  digicam: ['Light Leak', 'Polaroid', 'Y2K Digicam'],
  travel_film: ['Kodak Style', 'Faded Postcard', 'Deep Teal'],
};

export const VIBE_PACKS = Object.keys(PACK_VARIANTS);

/** Every (pack, variant) pair, flattened — 9 total. */
export const ALL_STYLES = VIBE_PACKS.flatMap((pack) =>
  PACK_VARIANTS[pack].map((variant) => ({ pack, variant })));

/**
 * "Sun-kissed" -> "sun-kissed", "Y2K Digicam" -> "y2k-digicam".
 * Filenames only — the wire format is always the display name, so there is no
 * second identifier for the app to keep in sync.
 */
export function slugifyVariant(variant) {
  return String(variant)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Case-insensitive, whitespace-tolerant lookup of a pack's canonical variant name. */
export function canonicalVariant(vibePack, variant) {
  const names = PACK_VARIANTS[vibePack];
  if (!names) return null;
  const wanted = slugifyVariant(variant);
  return names.find((n) => slugifyVariant(n) === wanted) ?? null;
}

/** Marker every placeholder file carries. See the file header. */
export const PLACEHOLDER_MARKER = 'TODO(style-instruction)';

export function isPlaceholder(instruction) {
  return String(instruction).includes(PLACEHOLDER_MARKER);
}

const cache = new Map();

/**
 * @param {string} vibePack one of VIBE_PACKS
 * @param {string} variant  a display name from PACK_VARIANTS[vibePack]
 * @returns {string} the style instruction text
 * @throws if the pair is unknown or the file is missing/empty
 */
export function loadStyleInstruction(vibePack, variant) {
  const canonicalPack = String(vibePack ?? '').trim();
  if (!Object.hasOwn(PACK_VARIANTS, canonicalPack)) {
    throw new Error(`unknown vibePack: ${canonicalPack}`);
  }
  const name = canonicalVariant(canonicalPack, variant);
  if (name === null) {
    throw new Error(`unknown variant for ${canonicalPack}: ${variant}`);
  }

  const key = `${canonicalPack}.${slugifyVariant(name)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Resolved relative to this module so it works regardless of cwd.
  const path = fileURLToPath(new URL(`../prompts/styles/${key}.txt`, import.meta.url));
  const text = readFileSync(path, 'utf8');

  if (text.trim().length === 0) {
    throw new Error(`empty style instruction file: prompts/styles/${key}.txt`);
  }

  cache.set(key, text);
  return text;
}

/** Test seam — clears the per-instance file cache. */
export function _resetStyleCache() {
  cache.clear();
}
