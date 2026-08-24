/**
 * Opening recognition.
 *
 * Naming the opening is the cheapest way to make a game feel like it knows
 * something about chess. Lookups walk backwards from the current line so the
 * name shown is always the most specific one that still matches, and it sticks
 * once play leaves book instead of blanking out mid-game.
 */
import { OPENING_TABLE, MAX_BOOK_PLY } from '../data/openings.js';

/** `'e4 c5 Nf3'` → `{ eco, name, ply }`. */
const BY_LINE = new Map(OPENING_TABLE.map(([line, eco, name]) => [line, { eco, name }]));

/**
 * Longest-prefix match over a SAN move list.
 * @param {string[]} sanMoves mainline SAN, in order
 * @returns {{ eco: string, name: string, ply: number } | null}
 */
export function identifyOpening(sanMoves) {
  const limit = Math.min(sanMoves.length, MAX_BOOK_PLY);
  for (let ply = limit; ply > 0; ply--) {
    const hit = BY_LINE.get(sanMoves.slice(0, ply).join(' '));
    if (hit) return { ...hit, ply };
  }
  return null;
}

/**
 * Every book continuation from a position, for opening variety and for the
 * "still in book" marker.
 *
 * `weight` counts how many catalogued lines run through the move. It is a crude
 * popularity proxy, but it is enough to stop a random pick from opening 1.g4 as
 * often as 1.e4.
 *
 * @param {string[]} sanMoves the line played so far
 * @returns {Array<{ san: string, eco: string, name: string, weight: number }>}
 */
export function bookContinuations(sanMoves) {
  const prefix = sanMoves.length ? `${sanMoves.join(' ')} ` : '';
  const seen = new Map();
  for (const [line, eco, name] of OPENING_TABLE) {
    if (!line.startsWith(prefix) || line.length === prefix.length - 1) continue;
    const next = line.slice(prefix.length).split(' ')[0];
    if (!next) continue;
    const existing = seen.get(next);
    if (existing) existing.weight++;
    else seen.set(next, { san: next, eco, name, weight: 1 });
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight);
}

/** Picks a continuation at random, favouring the better-catalogued lines. */
export function pickBookMove(sanMoves, random = Math.random) {
  const options = bookContinuations(sanMoves);
  if (!options.length) return null;
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return option;
  }
  return options[0];
}

/** How many plies of the line are still theory, for move-quality grading. */
export function bookDepth(sanMoves) {
  return identifyOpening(sanMoves)?.ply ?? 0;
}

export { MAX_BOOK_PLY };
