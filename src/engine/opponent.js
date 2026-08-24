/**
 * The computer opponent.
 *
 * Difficulty cannot be handed to the engine and forgotten. Stockfish 5 does
 * declare `Skill Level` (0-20), and that is used where available. Lozza and
 * p4wn declare nothing at all, and no bundled engine has `UCI_Elo` — that
 * arrived in Stockfish 11.
 *
 * Turning the search down is not enough on its own either: a shallow search
 * still never hangs a queen, so "easy" plays inhumanly solid chess right up
 * until it wins. So each level pairs a search budget with a chance of choosing
 * a deliberately worse move, drawn by static evaluation from a band of
 * plausible alternatives — mistakes that look like mistakes a person makes.
 */
import { Chess } from 'chess.js';
import { scoreMoves } from '../core/staticEval.js';

const toMove = (move) => ({ from: move.from, to: move.to, promotion: move.promotion });

/** Whether a SAN string is playable in a position. */
function isLegalSan(fen, san) {
  try {
    const chess = new Chess(fen);
    return chess.move(san) !== null;
  } catch {
    return false;
  }
}

const aborted = (startedAt) => ({
  move: null,
  san: null,
  source: 'aborted',
  evaluation: null,
  info: null,
  elapsedMs: performance.now() - startedAt,
});
import { pickBookMove } from '../core/openings.js';
import { parseUciMove } from './uciEngine.js';

/**
 * The ladder.
 *
 * `temperature` is in centipawns and drives a softmax over the candidate moves:
 * at 0 the best move is always played, and as it rises, moves that are only
 * slightly worse become nearly as likely. This is what makes the rungs feel
 * graded — a threshold-and-coin-flip model lurches, because every mistake it
 * makes is drawn from the same flat band.
 *
 * `catastropheRate` is a separate channel for the other kind of beginner error:
 * not a slightly inferior move but a piece left hanging. Softmax alone almost
 * never produces those, and their absence is what makes weak engines feel
 * uncannily solid.
 */
export const DIFFICULTY_LEVELS = Object.freeze([
  {
    level: 1,
    name: 'Novice',
    approxElo: 600,
    movetime: 60,
    depth: 1,
    temperature: 420,
    catastropheRate: 0.3,
    bookPlies: 0,
    minThinkMs: 350,
  },
  {
    level: 2,
    name: 'Casual',
    approxElo: 800,
    movetime: 100,
    depth: 2,
    temperature: 300,
    catastropheRate: 0.2,
    bookPlies: 2,
    minThinkMs: 350,
  },
  {
    level: 3,
    name: 'Club Beginner',
    approxElo: 1000,
    movetime: 150,
    depth: 3,
    temperature: 210,
    catastropheRate: 0.12,
    bookPlies: 4,
    minThinkMs: 400,
  },
  {
    level: 4,
    name: 'Club Player',
    approxElo: 1200,
    movetime: 250,
    depth: 4,
    temperature: 150,
    catastropheRate: 0.07,
    bookPlies: 6,
    minThinkMs: 400,
  },
  {
    level: 5,
    name: 'Intermediate',
    approxElo: 1400,
    movetime: 400,
    depth: 6,
    temperature: 100,
    catastropheRate: 0.035,
    bookPlies: 8,
    minThinkMs: 450,
  },
  {
    level: 6,
    name: 'Advanced',
    approxElo: 1600,
    movetime: 700,
    depth: 8,
    temperature: 65,
    catastropheRate: 0.015,
    bookPlies: 10,
    minThinkMs: 450,
  },
  {
    level: 7,
    name: 'Expert',
    approxElo: 1800,
    movetime: 1100,
    depth: 10,
    temperature: 40,
    catastropheRate: 0.006,
    bookPlies: 12,
    minThinkMs: 500,
  },
  {
    level: 8,
    name: 'Candidate Master',
    approxElo: 2000,
    movetime: 1800,
    depth: 12,
    temperature: 22,
    catastropheRate: 0.002,
    bookPlies: 14,
    minThinkMs: 500,
  },
  {
    level: 9,
    name: 'Master',
    approxElo: 2200,
    movetime: 3000,
    depth: null,
    temperature: 10,
    catastropheRate: 0,
    bookPlies: 16,
    minThinkMs: 500,
  },
  {
    level: 10,
    name: 'Full Strength',
    approxElo: null,
    movetime: 5000,
    depth: null,
    temperature: 0,
    catastropheRate: 0,
    bookPlies: 20,
    minThinkMs: 0,
  },
]);

export function difficultyByLevel(level) {
  return DIFFICULTY_LEVELS.find((entry) => entry.level === level) ?? DIFFICULTY_LEVELS[4];
}

const pick = (list, random) => list[Math.floor(random() * list.length)];

/**
 * Draws one entry from `scored` with probability proportional to
 * `exp(score / temperature)`.
 *
 * Scores are centipawns from the mover's point of view, so the temperature is
 * also in centipawns and reads directly: at 100, a move 100cp worse is about a
 * third as likely as the best one; at 20 it is essentially never played.
 *
 * @param {Array<{ score: number }>} scored best first
 * @param {number} temperature centipawns; 0 means always take the best
 * @param {() => number} random
 */
export function softmaxPick(scored, temperature, random = Math.random) {
  if (!scored.length) return null;
  if (temperature <= 0) return scored[0];

  // Subtract the max before exponentiating, or a large positive score overflows.
  const best = scored[0].score;
  const weights = scored.map((entry) => Math.exp((entry.score - best) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll <= 0) return scored[index];
  }
  return scored[0];
}

export class Opponent {
  /**
   * @param {{ engine: import('./uciEngine.js').UciEngine, level?: number,
   *           random?: () => number, pace?: number }} options
   *   `pace` scales the deliberate pause before an easy level replies — 1 for
   *   play, 0 to remove it (tests, and engine-vs-engine).
   */
  constructor({ engine, level = 5, random = Math.random, pace = 1 }) {
    this.engine = engine;
    this.random = random;
    this.pace = pace;
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = level;
    this.settings = difficultyByLevel(level);

    // Prefer the engine's own weakening where it exists: an engine playing
    // badly on purpose still plays coherently badly, which is more convincing
    // than a good move swapped for a worse one from outside.
    const { limitStrength, skillLevel } = this.engine.capabilities;
    if (limitStrength && this.settings.approxElo) {
      this.engine.setOption('UCI_LimitStrength', 'true');
      this.engine.setOption('UCI_Elo', this.settings.approxElo);
      this.usesNativeStrength = true;
    } else if (skillLevel) {
      // Stockfish 5's Skill Level runs 0-20. Level 10 is full strength, so map
      // 1-9 across 0-20 and leave 10 to mean "don't hold back".
      this.engine.setOption('Skill Level', level >= 10 ? 20 : Math.round((level - 1) * (18 / 8)));
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
    //
    // The book is looked up by move history, but the position is what actually
    // has to accept the move. Those can disagree — a restored game, an imported
    // PGN starting from a set-up position — and a book move that is illegal
    // here would be rejected by the rules and leave the game waiting forever
    // for a move the computer already thinks it made.
    if (sanHistory.length < settings.bookPlies) {
      const chosen = pickBookMove(sanHistory, this.random);
      if (chosen && isLegalSan(fen, chosen.san)) {
        await this.#pause(settings.minThinkMs * this.pace, startedAt, signal);
        if (signal?.aborted) return aborted(startedAt);
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

    let result;
    try {
      result = await this.engine.search(fen, limits);
    } catch (error) {
      // A cancelled or timed-out search is not a crash; the caller decides.
      return {
        move: null,
        san: null,
        source: 'aborted',
        error,
        evaluation: null,
        info: null,
        elapsedMs: performance.now() - startedAt,
      };
    }
    const best = parseUciMove(result.bestmove);
    if (!best) {
      return {
        move: null,
        san: null,
        source: 'none',
        evaluation: null,
        info: result.info,
        elapsedMs: performance.now() - startedAt,
      };
    }

    // 3. Optionally err on purpose. Skipped when the engine is already playing
    //    below strength for us — two weakening layers stack unpredictably.
    let move = best;
    let source = 'engine';
    // Native strength limiting and our own sampling COMPOSE rather than
    // exclude: Skill Level alone makes Stockfish rung 3 a different opponent
    // from Lozza rung 3, which is exactly the inconsistency the ladder exists
    // to remove. When the engine is already holding back, sample more gently.
    const temperature = this.usesNativeStrength
      ? settings.temperature * 0.35
      : settings.temperature;
    const catastropheRate = this.usesNativeStrength
      ? settings.catastropheRate * 0.4
      : settings.catastropheRate;

    if (temperature > 0 || catastropheRate > 0) {
      const alternative = this.#chooseHumanlyImperfectMove(fen, result, {
        temperature,
        catastropheRate,
      });
      if (alternative && alternative.uci !== result.bestmove) {
        move = alternative.move;
        source = alternative.source;
      }
    }

    await this.#pause(settings.minThinkMs * this.pace, startedAt, signal);
    // The pause resolves early on abort, so it has to be re-checked: otherwise
    // a take-back during the humanising delay still returns a playable move and
    // the engine's move lands after the position has already changed.
    if (signal?.aborted) return aborted(startedAt);
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
   * Chooses the move this level actually plays.
   *
   * Candidates come from the engine's MultiPV lines where the engine provides
   * them and from the static evaluation otherwise, but the selection is the
   * same either way — which is what keeps the ladder consistent when the player
   * switches engines mid-game.
   */
  #chooseHumanlyImperfectMove(fen, result, { temperature, catastropheRate }) {
    const scored = scoreMoves(fen);
    if (scored.length < 2) return null;
    const uciOf = (move) => `${move.from}${move.to}${move.promotion ?? ''}`;

    // The engine knows better than the static evaluation, so anchor its choice
    // at the top of the list rather than letting the static score demote it.
    const anchored = scored.map((entry) =>
      uciOf(entry.move) === result.bestmove
        ? { ...entry, score: Math.max(entry.score, scored[0].score) }
        : entry,
    );
    anchored.sort((a, b) => b.score - a.score);

    // The catastrophe channel: occasionally play something that really does
    // drop material, which softmax on its own almost never produces.
    if (catastropheRate > 0 && this.random() < catastropheRate) {
      const best = anchored[0].score;
      const howlers = anchored.filter((entry) => best - entry.score > 150);
      if (howlers.length) {
        const chosen = pick(howlers, this.random);
        return { move: toMove(chosen.move), uci: uciOf(chosen.move), source: 'blunder' };
      }
    }

    const chosen = softmaxPick(anchored, temperature, this.random);
    if (!chosen) return null;
    return { move: toMove(chosen.move), uci: uciOf(chosen.move), source: 'weakened' };
  }

  /** Keeps instant replies from feeling like a lookup table. */
  #pause(minMs, startedAt, signal) {
    const remaining = minMs - (performance.now() - startedAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
