/**
 * The computer opponent.
 *
 * None of the engines we ship declare `UCI_Elo` or `Skill Level`, so difficulty
 * cannot simply be handed to the engine. Turning the search down alone doesn't
 * work either: a shallow search still never hangs a queen, so "easy" plays
 * inhumanly solid chess and then suddenly wins. Instead each level combines a
 * search budget with a chance of choosing a deliberately worse move, picked by
 * static evaluation from a band of plausible alternatives — the mistakes look
 * like mistakes a person would make.
 */
import { scoreMoves } from '../core/staticEval.js';
import { pickBookMove } from '../core/openings.js';
import { parseUciMove } from './uciEngine.js';

/**
 * `blunderRate` is the chance of not playing the engine's move; `blunderBand`
 * is how many centipawns worse the substitute may be. `bookPlies` is how long
 * the level plays from the opening book, which mostly buys opening variety.
 */
export const DIFFICULTY_LEVELS = Object.freeze([
  { level: 1, name: 'Novice', approxElo: 600, movetime: 60, depth: 1, blunderRate: 0.5, blunderBand: 900, bookPlies: 0, minThinkMs: 350 },
  { level: 2, name: 'Casual', approxElo: 800, movetime: 100, depth: 2, blunderRate: 0.38, blunderBand: 700, bookPlies: 2, minThinkMs: 350 },
  { level: 3, name: 'Club Beginner', approxElo: 1000, movetime: 150, depth: 3, blunderRate: 0.28, blunderBand: 500, bookPlies: 4, minThinkMs: 400 },
  { level: 4, name: 'Club Player', approxElo: 1200, movetime: 250, depth: 4, blunderRate: 0.2, blunderBand: 350, bookPlies: 6, minThinkMs: 400 },
  { level: 5, name: 'Intermediate', approxElo: 1400, movetime: 400, depth: 6, blunderRate: 0.13, blunderBand: 250, bookPlies: 8, minThinkMs: 450 },
  { level: 6, name: 'Advanced', approxElo: 1600, movetime: 700, depth: 8, blunderRate: 0.08, blunderBand: 180, bookPlies: 10, minThinkMs: 450 },
  { level: 7, name: 'Expert', approxElo: 1800, movetime: 1100, depth: 10, blunderRate: 0.04, blunderBand: 120, bookPlies: 12, minThinkMs: 500 },
  { level: 8, name: 'Candidate Master', approxElo: 2000, movetime: 1800, depth: 12, blunderRate: 0.02, blunderBand: 80, bookPlies: 14, minThinkMs: 500 },
  { level: 9, name: 'Master', approxElo: 2200, movetime: 3000, depth: null, blunderRate: 0.005, blunderBand: 50, bookPlies: 16, minThinkMs: 500 },
  { level: 10, name: 'Full Strength', approxElo: null, movetime: 5000, depth: null, blunderRate: 0, blunderBand: 0, bookPlies: 20, minThinkMs: 0 },
]);

export function difficultyByLevel(level) {
  return DIFFICULTY_LEVELS.find((entry) => entry.level === level) ?? DIFFICULTY_LEVELS[4];
}

const pick = (list, random) => list[Math.floor(random() * list.length)];

export class Opponent {
  /**
   * @param {{ engine: import('./uciEngine.js').UciEngine, level?: number,
   *           random?: () => number, personality?: string }} options
   */
  constructor({ engine, level = 5, random = Math.random, personality = 'balanced' }) {
    this.engine = engine;
    this.random = random;
    this.personality = personality;
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = level;
    this.settings = difficultyByLevel(level);
    // If an engine *does* expose strength limiting, prefer it over our own
    // weakening — a real Elo cap plays better-shaped weak chess than we can fake.
    const { limitStrength, skillLevel } = this.engine.capabilities;
    if (limitStrength && this.settings.approxElo) {
      this.engine.setOption('UCI_LimitStrength', 'true');
      this.engine.setOption('UCI_Elo', this.settings.approxElo);
      this.usesNativeStrength = true;
    } else if (skillLevel) {
      this.engine.setOption('Skill Level', Math.round((level - 1) * (20 / 9)));
      this.usesNativeStrength = true;
    } else {
      this.usesNativeStrength = false;
    }
    return this.settings;
  }

  /**
   * Chooses a move for the position.
   *
   * @param {{ fen: string, sanHistory: string[], signal?: AbortSignal,
   *           onInfo?: (info: object) => void, timeLeft?: number }} context
   * @returns {Promise<{ move: {from,to,promotion}|null, san: string|null, source: string,
   *                     evaluation: object|null, info: object|null, elapsedMs: number }>}
   */
  async chooseMove({ fen, sanHistory = [], signal, onInfo, timeLeft = null }) {
    const startedAt = performance.now();
    const settings = this.settings;

    // 1. Opening book, while the level still has book left.
    if (sanHistory.length < settings.bookPlies) {
      const chosen = pickBookMove(sanHistory, this.random);
      if (chosen) {
        await this.#pause(settings.minThinkMs, startedAt, signal);
        return {
          move: null,
          san: chosen.san,
          source: 'book',
          opening: chosen,
          evaluation: null,
          info: null,
          elapsedMs: performance.now() - startedAt,
        };
      }
    }

    // 2. Ask the engine. Never spend more than a slice of the remaining clock.
    const movetime = timeLeft
      ? Math.max(50, Math.min(settings.movetime, Math.floor(timeLeft / 20)))
      : settings.movetime;
    const limits = { movetime, onInfo, signal };
    if (settings.depth && !this.usesNativeStrength) limits.depth = settings.depth;

    const result = await this.engine.search(fen, limits);
    const best = parseUciMove(result.bestmove);
    if (!best) {
      return { move: null, san: null, source: 'none', evaluation: null, info: result.info, elapsedMs: performance.now() - startedAt };
    }

    // 3. Optionally err on purpose.
    let move = best;
    let source = 'engine';
    if (!this.usesNativeStrength && settings.blunderRate > 0 && this.random() < settings.blunderRate) {
      const alternative = this.#pickPlausibleMistake(fen, result.bestmove);
      if (alternative) {
        move = alternative;
        source = 'weakened';
      }
    }

    await this.#pause(settings.minThinkMs, startedAt, signal);
    return {
      move,
      san: null,
      source,
      evaluation: result.info?.score ?? null,
      info: result.info,
      lines: result.lines,
      elapsedMs: performance.now() - startedAt,
    };
  }

  /**
   * Picks a move that is worse than best but not absurd: still inside the
   * level's band, and never a move that simply throws a piece away for nothing
   * unless the band is wide enough that a beginner plausibly would.
   */
  #pickPlausibleMistake(fen, bestUci) {
    const scored = scoreMoves(fen);
    if (scored.length < 2) return null;
    const bestScore = scored[0].score;
    const band = this.settings.blunderBand;

    const candidates = scored.filter((entry) => {
      const uci = `${entry.move.from}${entry.move.to}${entry.move.promotion ?? ''}`;
      if (uci === bestUci) return false;
      const loss = bestScore - entry.score;
      // Slightly-worse moves are the most human; require a real drop so the
      // "mistake" is actually visible, but stay inside the level's ceiling.
      return loss > 20 && loss <= band;
    });

    const chosen = candidates.length ? pick(candidates, this.random) : null;
    if (!chosen) return null;
    return {
      from: chosen.move.from,
      to: chosen.move.to,
      promotion: chosen.move.promotion,
    };
  }

  /** Keeps instant replies from feeling like a lookup table. */
  #pause(minMs, startedAt, signal) {
    const remaining = minMs - (performance.now() - startedAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
