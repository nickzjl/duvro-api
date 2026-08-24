/**
 * Tests for the style-instruction loader.
 *
 * The load-bearing one is "every (pack, variant) pair resolves to a file":
 * a missing or misnamed file would only surface at generation time, after the
 * entitlement is spent and the user is already waiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_STYLES,
  PACK_VARIANTS,
  PLACEHOLDER_MARKER,
  VIBE_PACKS,
  canonicalVariant,
  isPlaceholder,
  loadStyleInstruction,
  slugifyVariant,
} from '../lib/styles.js';

test('there are exactly nine (pack, variant) pairs — three packs of three', () => {
  assert.equal(VIBE_PACKS.length, 3);
  assert.equal(ALL_STYLES.length, 9);
  for (const pack of VIBE_PACKS) {
    assert.equal(PACK_VARIANTS[pack].length, 3, `${pack} must have 3 variants`);
  }
});

test('every one of the nine pairs loads a non-empty instruction file', () => {
  for (const { pack, variant } of ALL_STYLES) {
    const text = loadStyleInstruction(pack, variant);
    assert.ok(text.trim().length > 0, `${pack}/${variant} must not be empty`);
  }
});

test('every instruction is currently a placeholder, and says so', () => {
  // When a real instruction is written this test should be updated, not deleted:
  // the point is that placeholder-ness is always known, never assumed.
  for (const { pack, variant } of ALL_STYLES) {
    const text = loadStyleInstruction(pack, variant);
    assert.ok(
      isPlaceholder(text),
      `${pack}/${variant} lost its ${PLACEHOLDER_MARKER} marker — if the real instruction was written, update this test`,
    );
  }
});

test('each placeholder names its own pack and variant, so files cannot be silently swapped', () => {
  for (const { pack, variant } of ALL_STYLES) {
    const text = loadStyleInstruction(pack, variant);
    assert.ok(text.includes(pack), `${pack}/${variant} should name its pack`);
    assert.ok(text.includes(variant), `${pack}/${variant} should name its variant`);
  }
});

test('variant names are matched case- and whitespace-insensitively', () => {
  assert.equal(canonicalVariant('golden_hour', 'sun-kissed'), 'Sun-kissed');
  assert.equal(canonicalVariant('golden_hour', '  SUN-KISSED  '), 'Sun-kissed');
  assert.equal(canonicalVariant('digicam', 'y2k digicam'), 'Y2K Digicam');
  assert.equal(canonicalVariant('travel_film', 'Deep Teal'), 'Deep Teal');
});

test('a variant from the wrong pack does not resolve', () => {
  assert.equal(canonicalVariant('golden_hour', 'Deep Teal'), null);
  assert.equal(canonicalVariant('digicam', 'Sun-kissed'), null);
});

test('an unknown pack or variant throws rather than loading the wrong file', () => {
  assert.throws(() => loadStyleInstruction('nope', 'Sun-kissed'), /unknown vibePack/);
  assert.throws(() => loadStyleInstruction('golden_hour', 'Nonexistent'), /unknown variant/);
  // Cross-pack pairing is the realistic mistake, and must not silently succeed.
  assert.throws(() => loadStyleInstruction('golden_hour', 'Polaroid'), /unknown variant/);
});

test('slugify handles the awkward real names', () => {
  assert.equal(slugifyVariant('Sun-kissed'), 'sun-kissed');
  assert.equal(slugifyVariant('Y2K Digicam'), 'y2k-digicam');
  assert.equal(slugifyVariant('Faded Postcard'), 'faded-postcard');
  assert.equal(slugifyVariant('Polaroid'), 'polaroid');
});

test('repeated loads are cached but return identical content', () => {
  const a = loadStyleInstruction('digicam', 'Polaroid');
  const b = loadStyleInstruction('digicam', 'Polaroid');
  assert.equal(a, b);
});

test('variant order matches the app: variants[0] leads the pack', () => {
  // The app pre-selects variants[0] on arrival and the showcase leads with it,
  // so this ordering is a contract, not an incidental detail.
  assert.equal(PACK_VARIANTS.golden_hour[0], 'Sun-kissed');
  assert.equal(PACK_VARIANTS.digicam[0], 'Light Leak');
  assert.equal(PACK_VARIANTS.travel_film[0], 'Kodak Style');
});
