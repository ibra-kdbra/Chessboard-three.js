/**
 * What each bundled engine actually does, as measured — not as UCI says it
 * should.
 *
 * All three are quirky in ways that break a by-the-book driver, and the quirks
 * are not discoverable at runtime, so they are declared here and the adapter
 * applies them. Every claim below was checked against the shipped file rather
 * than assumed from the protocol.
 */

/**
 * @typedef {object} EngineProfile
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} strength human-readable rating estimate
 * @property {string} licence
 * @property {boolean} newGameBeforePosition send `ucinewgame` before the first `position`
 * @property {boolean} sanPv the PV arrives as SAN, not UCI coordinates
 * @property {boolean} infoAfterBestMove `info` follows `bestmove` instead of preceding it
 * @property {number} mateOffset add this to a reported mate distance to get the true one
 * @property {number} cpScale multiply reported centipawns by this
 * @property {boolean} cpParityFlips the score's sign depends on search depth parity
 * @property {'movetime'|'depth'} budget which `go` limit this engine honours
 * @property {number} maxDepth never ask for more than this
 * @property {boolean} refusesGameOver hangs if asked to search a finished position
 */

/** Every search blocks the worker's event loop, so nothing can interrupt one. */
export const NO_ENGINE_SUPPORTS_STOP = true;

/** @type {Record<string, EngineProfile>} */
export const ENGINE_PROFILES = Object.freeze({
  lozza: {
    id: 'lozza',
    name: 'Lozza',
    url: 'engines/lozza.js',
    strength: '≈2300',
    licence: 'MIT — Colin Jenkins',
    blurb: 'A strong pure-JavaScript engine. Fast to start, plays a sharp game.',
    newGameBeforePosition: false,
    sanPv: true, // lozzaHost defaults to HOST_WEB, which switches move output to SAN
    infoAfterBestMove: false,
    mateOffset: 1, // reports mate-in-1 as `mate 0`
    cpScale: 1,
    cpParityFlips: false,
    budget: 'movetime',
    maxDepth: 24,
    // Searching a mated or stalemated position never returns and floods the
    // main thread with info lines.
    refusesGameOver: true,
    // A `go` with no limit at all searches to depth 100 and never comes back.
    requiresExplicitLimit: true,
  },
  stockfish: {
    id: 'stockfish',
    name: 'Stockfish 5',
    url: 'engines/stockfish.js',
    strength: '≈3000',
    licence: 'GPL-3.0 — the Stockfish authors',
    blurb: 'The classic. Bundled as asm.js, so it is a 1.1MB download.',
    newGameBeforePosition: false,
    sanPv: false,
    infoAfterBestMove: false,
    mateOffset: 0,
    cpScale: 1,
    cpParityFlips: false,
    budget: 'movetime',
    maxDepth: 30,
    refusesGameOver: false,
    requiresExplicitLimit: true,
  },
  p4wn: {
    id: 'p4wn',
    name: 'p4wn',
    url: 'engines/p4wn.js',
    strength: '≈1100',
    licence: 'ISC — Douglas Bagnall',
    blurb: 'Tiny and cheerful. A good opponent if you are learning.',
    // `_state` is undefined until ucinewgame runs; `position` without it throws
    // inside the worker and the search never settles.
    newGameBeforePosition: true,
    sanPv: false,
    // Posts `bestmove` first and its single `info` line afterwards.
    infoAfterBestMove: true,
    mateOffset: 0,
    // P4_VALUES puts a pawn at 20, so its "centipawns" are a fifth of real ones.
    cpScale: 5,
    cpParityFlips: true,
    // Its `go` regex discards every limit except `depth`, and only when depth
    // is the last one in the string.
    budget: 'depth',
    maxDepth: 6, // depth 6 already takes well over a second
    refusesGameOver: false,
    requiresExplicitLimit: true,
  },
});

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINE_PROFILES));
export const DEFAULT_ENGINE = 'lozza';

export function getEngineProfile(id) {
  return ENGINE_PROFILES[id] ?? ENGINE_PROFILES[DEFAULT_ENGINE];
}

/**
 * Turns a desired search budget into the one limit this engine will honour.
 * @param {EngineProfile} profile
 * @param {{ movetime?: number, depth?: number }} wanted
 */
export function budgetFor(profile, wanted) {
  if (profile.budget === 'depth') {
    // p4wn ignores movetime entirely; approximate it with a ply count instead
    // of sending a limit it will silently drop.
    const fromTime = wanted.movetime
      ? Math.round(Math.log2(Math.max(1, wanted.movetime / 40))) + 2
      : 4;
    return { depth: Math.min(profile.maxDepth, Math.max(1, wanted.depth ?? fromTime)) };
  }
  const limits = { movetime: Math.max(20, wanted.movetime ?? 1000) };
  if (wanted.depth) limits.depth = Math.min(profile.maxDepth, wanted.depth);
  return limits;
}
