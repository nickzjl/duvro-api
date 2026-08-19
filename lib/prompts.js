/**
 * Loads the system prompt for a (vibePack, tier) pair from prompts/*.txt.
 *
 * Prompts are plain text files, not string literals, so they can be edited
 * without touching code. They are read once per warm Lambda and cached in
 * memory — the file contents are static, so this is safe.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VIBE_PACKS = ['golden_hour', 'digicam', 'travel_film'];
export const TIERS = ['basic', 'premium'];

const cache = new Map();

/**
 * @param {string} vibePack one of VIBE_PACKS
 * @param {string} tier     one of TIERS
 * @returns {string} the system prompt text
 * @throws if the pair is unknown or the file is missing
 */
export function loadSystemPrompt(vibePack, tier) {
  if (!VIBE_PACKS.includes(vibePack)) {
    throw new Error(`unknown vibePack: ${vibePack}`);
  }
  if (!TIERS.includes(tier)) {
    throw new Error(`unknown tier: ${tier}`);
  }

  const key = `${vibePack}.${tier}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Resolved relative to this module so it works regardless of cwd.
  const path = fileURLToPath(new URL(`../prompts/${key}.txt`, import.meta.url));
  const text = readFileSync(path, 'utf8');

  if (text.trim().length === 0) {
    throw new Error(`empty prompt file: prompts/${key}.txt`);
  }

  cache.set(key, text);
  return text;
}
