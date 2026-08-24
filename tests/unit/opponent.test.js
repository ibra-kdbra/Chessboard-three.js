import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_LEVELS,
  Opponent,
  difficultyByLevel,
  softmaxPick,
} from '../../src/engine/opponent.js';

/** Deterministic PRNG, so a "random" opponent is reproducible in a test. */
function seeded(seed = 12345) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const fakeEngine = (bestmove = 'e2e4', capabilities = {}) => ({
  capabilities: { multiPv: false, limitStrength: false, skillLevel: false, ...capabilities },
  setOption: () => false,
  search: async () => ({
    bestmove,
    ponder: null,
    info: { score: { type: 'cp', value: 30 } },
    lines: [],
  }),
});

describe('difficulty ladder', () => {
  it('is monotonic: every rung is at least as strong as the one below', () => {
    for (let i = 1; i < DIFFICULTY_LEVELS.length; i++) {
      const lower = DIFFICULTY_LEVELS[i - 1];
      const higher = DIFFICULTY_LEVELS[i];
      expect(higher.temperature).toBeLessThanOrEqual(lower.temperature);
      expect(higher.catastropheRate).toBeLessThanOrEqual(lower.catastropheRate);
      expect(higher.movetime).toBeGreaterThanOrEqual(lower.movetime);
    }
  });

  it('plays perfectly at the top rung and never at the bottom', () => {
    expect(DIFFICULTY_LEVELS.at(-1).temperature).toBe(0);
    expect(DIFFICULTY_LEVELS.at(-1).catastropheRate).toBe(0);
    expect(DIFFICULTY_LEVELS[0].temperature).toBeGreaterThan(100);
  });

  it('falls back to a real level for a nonsense one', () => {
    expect(difficultyByLevel(99).level).toBeGreaterThan(0);
  });
});

describe('softmaxPick', () => {
  const scored = [{ score: 100 }, { score: 60 }, { score: 20 }, { score: -150 }];

  it('always takes the best move at zero temperature', () => {
    const random = seeded();
    for (let i = 0; i < 50; i++) expect(softmaxPick(scored, 0, random).score).toBe(100);
  });

  it('spreads the choice wider as temperature rises', () => {
    const share = (temperature) => {
      const random = seeded(7);
      let best = 0;
      for (let i = 0; i < 3000; i++)
        if (softmaxPick(scored, temperature, random).score === 100) best++;
      return best / 3000;
    };
    const cold = share(10);
    const warm = share(100);
    const hot = share(400);

    expect(cold).toBeGreaterThan(0.9);
    expect(warm).toBeLessThan(cold);
    expect(hot).toBeLessThan(warm);
    // Even at the top temperature the best move stays the most likely one.
    expect(hot).toBeGreaterThan(1 / scored.length);
  });

  it('survives an empty or single-entry list', () => {
    expect(softmaxPick([], 100)).toBeNull();
    expect(softmaxPick([{ score: 5 }], 100).score).toBe(5);
  });

  it('does not overflow on large scores', () => {
    const huge = [{ score: 20000 }, { score: 19000 }];
    expect(softmaxPick(huge, 50, seeded()).score).toBe(20000);
  });
});

describe('Opponent', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('plays from the book while the level still has book left', async () => {
    const opponent = new Opponent({ engine: fakeEngine(), level: 10, random: seeded(), pace: 0 });
    const choice = await opponent.chooseMove({ fen: START, sanHistory: ['e4', 'e5'] });
    expect(choice.source).toBe('book');
    expect(typeof choice.san).toBe('string');
  });

  it('asks the engine once the book runs out', async () => {
    // Rung 1 has no book at all, so this must go to the engine — though at that
    // temperature the engine's answer is unlikely to survive unchanged.
    const opponent = new Opponent({ engine: fakeEngine(), level: 1, random: () => 0.999, pace: 0 });
    const choice = await opponent.chooseMove({ fen: START, sanHistory: [] });
    expect(choice.source).not.toBe('book');
    expect(choice.move).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });

  it('plays the engine move unchanged at full strength', async () => {
    const opponent = new Opponent({ engine: fakeEngine(), level: 10, random: seeded(), pace: 0 });
    const choice = await opponent.chooseMove({ fen: START, sanHistory: new Array(30).fill('x') });
    expect(choice.source).toBe('engine');
    expect(choice.move).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
  });

  it('sometimes chooses a worse move at a low rung', async () => {
    const sources = new Set();
    for (let seed = 1; seed <= 25; seed++) {
      const opponent = new Opponent({
        engine: fakeEngine(),
        level: 1,
        random: seeded(seed),
        pace: 0,
      });
      const choice = await opponent.chooseMove({ fen: START, sanHistory: [] });
      sources.add(choice.source);
    }
    expect(sources.has('weakened') || sources.has('blunder')).toBe(true);
  });

  it('still weakens when the engine limits its own strength', async () => {
    // Skill Level alone would make rung 3 on Stockfish a different opponent
    // from rung 3 on Lozza.
    const opponent = new Opponent({
      engine: fakeEngine('e2e4', { skillLevel: true }),
      level: 2,
      random: seeded(3),
      pace: 0,
    });
    expect(opponent.usesNativeStrength).toBe(true);
    const sources = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      const each = new Opponent({
        engine: fakeEngine('e2e4', { skillLevel: true }),
        level: 2,
        random: seeded(seed),
        pace: 0,
      });
      // Out of book, or every answer would just be a book move.
      sources.add(
        (await each.chooseMove({ fen: START, sanHistory: new Array(30).fill('x') })).source,
      );
    }
    expect(sources.size).toBeGreaterThan(1);
  });

  it('reports an aborted search rather than throwing', async () => {
    const engine = {
      capabilities: { multiPv: false, limitStrength: false, skillLevel: false },
      setOption: () => false,
      search: async () => {
        throw new Error('search cancelled');
      },
    };
    const opponent = new Opponent({ engine, level: 5, random: seeded(), pace: 0 });
    const choice = await opponent.chooseMove({ fen: START, sanHistory: new Array(30).fill('x') });
    expect(choice.source).toBe('aborted');
    expect(choice.move).toBeNull();
  });
});

describe('Opponent safety', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('never plays a book move that is illegal in the actual position', async () => {
    // History and position disagree — a restored game, or a PGN that began from
    // a set-up position. The book move for this history cannot be played here.
    const mismatched = '8/8/8/8/8/5k2/8/6K1 w - - 0 40';
    for (let seed = 1; seed <= 20; seed++) {
      const opponent = new Opponent({
        engine: fakeEngine('g1f1'),
        level: 10,
        random: seeded(seed),
        pace: 0,
      });
      const choice = await opponent.chooseMove({ fen: mismatched, sanHistory: ['e4'] });
      expect(choice.source, 'played a book move from a mismatched history').not.toBe('book');
    }
  });

  it('reports an abort that lands during the humanising pause', async () => {
    const controller = new AbortController();
    const opponent = new Opponent({
      engine: fakeEngine(),
      level: 1,
      random: seeded(4),
      // Full pacing, so the abort has a pause to land inside.
      pace: 1,
    });
    const pending = opponent.chooseMove({
      fen: START,
      sanHistory: new Array(30).fill('x'),
      signal: controller.signal,
    });
    controller.abort();
    const choice = await pending;

    expect(choice.source).toBe('aborted');
    expect(choice.move).toBeNull();
  });
});
