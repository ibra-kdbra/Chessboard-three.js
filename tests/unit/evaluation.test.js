import { describe, expect, it } from 'vitest';
import {
  accuracyFromLosses,
  classifyMove,
  evaluationToBar,
  expectedScore,
  formatEvaluation,
  reviewGame,
  toWhitePov,
  winningChances,
} from '../../src/core/evaluation.js';
import { GameTree } from '../../src/core/gameTree.js';

describe('evaluation maths', () => {
  it('maps centipawns to the expected-score calibration', () => {
    expect(winningChances(0)).toBeCloseTo(0, 5);
    // The long-standing fit: +300cp is roughly a 75% expected score.
    expect(expectedScore({ type: 'cp', value: 300 })).toBeCloseTo(0.75, 2);
    expect(expectedScore({ type: 'cp', value: -300 })).toBeCloseTo(0.25, 2);
    expect(expectedScore(null)).toBe(0.5);
  });

  it('treats mate as decided', () => {
    expect(expectedScore({ type: 'mate', value: 3 })).toBe(1);
    expect(expectedScore({ type: 'mate', value: -3 })).toBe(0);
  });

  it('formats scores the way a player reads them', () => {
    expect(formatEvaluation({ type: 'cp', value: 124 })).toBe('+1.24');
    expect(formatEvaluation({ type: 'cp', value: -30 })).toBe('-0.30');
    expect(formatEvaluation({ type: 'cp', value: 1250 })).toBe('+12.5');
    expect(formatEvaluation({ type: 'mate', value: 4 })).toBe('M4');
    expect(formatEvaluation({ type: 'mate', value: -2 })).toBe('-M2');
    expect(formatEvaluation(null)).toBe('—');
  });

  it('keeps a sliver of the losing colour on the bar until it is mate', () => {
    expect(evaluationToBar(null)).toBe(0.5);
    expect(evaluationToBar({ type: 'cp', value: 5000 })).toBeLessThan(1);
    expect(evaluationToBar({ type: 'cp', value: 5000 })).toBeGreaterThan(0.9);
    expect(evaluationToBar({ type: 'mate', value: 1 })).toBe(1);
    expect(evaluationToBar({ type: 'mate', value: -1 })).toBe(0);
  });

  it('flips a side-to-move score to white-relative', () => {
    expect(toWhitePov({ type: 'cp', value: 40 }, 'b')).toEqual({ type: 'cp', value: -40 });
    expect(toWhitePov({ type: 'cp', value: 40 }, 'w')).toEqual({ type: 'cp', value: 40 });
  });
});

describe('classifyMove', () => {
  const before = { type: 'cp', value: 20 };

  it('grades by expected score lost, not by raw centipawns', () => {
    expect(classifyMove(before, { type: 'cp', value: 15 })).toBe('excellent');
    expect(classifyMove(before, { type: 'cp', value: -80 })).toBe('inaccuracy');
    expect(classifyMove(before, { type: 'cp', value: -300 })).toBe('blunder');
  });

  it('a 100cp swing when already winning is not a blunder', () => {
    // +900 to +800 is nothing; +20 to -80 is a real concession.
    expect(classifyMove({ type: 'cp', value: 900 }, { type: 'cp', value: 800 })).toBe('excellent');
  });

  it('labels book moves and best moves specially', () => {
    expect(classifyMove(before, { type: 'cp', value: -400 }, { isBook: true })).toBe('book');
    expect(classifyMove(before, { type: 'cp', value: 22 }, { wasBest: true })).toBe('best');
    expect(
      classifyMove(before, { type: 'cp', value: 22 }, { wasBest: true, sacrifice: true }),
    ).toBe('brilliant');
  });
});

describe('accuracy', () => {
  it('is 100 for flawless play and drops with the size of the error', () => {
    expect(accuracyFromLosses([])).toBe(100);
    expect(accuracyFromLosses([0, 0, 0, 0])).toBe(100);
    const oneBlunder = accuracyFromLosses([0, 0, 0, 0.35]);
    expect(oneBlunder).toBeLessThan(90);
    expect(oneBlunder).toBeGreaterThan(60);
    expect(accuracyFromLosses([0.4, 0.4, 0.4])).toBeLessThan(oneBlunder);
  });
});

describe('reviewGame', () => {
  it('annotates the mainline and totals each side separately', () => {
    const tree = new GameTree('start');
    tree.root.evaluation = { type: 'cp', value: 0 };
    const add = (san, value) => {
      const node = tree.addMove({ san, color: tree.current.ply % 2 === 0 ? 'w' : 'b' }, 'fen');
      node.evaluation = { type: 'cp', value };
      return node;
    };
    // Evaluations are white-relative throughout, so a black blunder is a
    // move after which WHITE's score jumps.
    add('e4', 20);
    add('e5', 15);
    add('Nf3', 25);
    add('Qh4', 400); // black throws it away: white is now up four pawns

    const review = reviewGame(tree);
    expect(review.b.blunder).toBe(1);
    expect(review.w.blunder).toBe(0);
    expect(review.b.accuracy).toBeLessThan(review.w.accuracy);
  });

  it('skips nodes with no evaluation rather than inventing one', () => {
    const tree = new GameTree('start');
    tree.addMove({ san: 'e4', color: 'w' }, 'fen');
    const review = reviewGame(tree);
    expect(review.w.moves).toBe(0);
    expect(review.w.accuracy).toBe(100);
  });
});
