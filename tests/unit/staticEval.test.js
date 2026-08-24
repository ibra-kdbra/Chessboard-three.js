import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  evaluateForSideToMove,
  evaluatePosition,
  findHangingPieces,
  scoreMoves,
} from '../../src/core/staticEval.js';

describe('static evaluation', () => {
  it('scores the start position as dead level', () => {
    expect(evaluatePosition(new Chess())).toBe(0);
  });

  it('is symmetric under colour reversal', () => {
    const white = evaluatePosition(
      new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1'),
    );
    const black = evaluatePosition(
      new Chess('rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    );
    expect(white).toBeCloseTo(-black, 5);
  });

  it('counts a missing queen as roughly nine pawns', () => {
    const score = evaluatePosition(
      new Chess('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    );
    expect(score).toBeGreaterThan(850);
    expect(score).toBeLessThan(950);
  });

  it('reports checkmate from the mated side as a loss', () => {
    // Fool's mate: white is checkmated.
    const mated = new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    expect(evaluatePosition(mated)).toBeLessThan(-10000);
    expect(evaluateForSideToMove(mated)).toBeLessThan(-10000);
  });

  it('prefers developing and central moves in the opening', () => {
    const best = scoreMoves('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
      .slice(0, 4)
      .map((entry) => entry.move.san);
    expect(best.some((san) => ['e4', 'd4', 'Nf3', 'Nc3'].includes(san))).toBe(true);
    expect(best).not.toContain('a3');
  });

  it('returns every legal move, best first', () => {
    const scored = scoreMoves('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(scored).toHaveLength(20);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it('spots an undefended attacked piece', () => {
    // Black pawn on e5 attacked by the d4 pawn, with nothing defending it.
    const hanging = findHangingPieces(
      'rnbqkb1r/pppp1ppp/5n2/4p3/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 3',
      'b',
    );
    expect(hanging).toContainEqual(expect.objectContaining({ square: 'e5', type: 'p' }));
  });

  it('does not flag a piece defended by something cheaper', () => {
    // e5 pawn is attacked by the d4 pawn but defended by the d6 pawn.
    const hanging = findHangingPieces(
      'rnbqkbnr/ppp2ppp/3p4/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 3',
      'b',
    );
    expect(hanging.find((entry) => entry.square === 'e5')).toBeUndefined();
  });

  it('never flags a king', () => {
    const hanging = findHangingPieces('4k3/8/4R3/8/8/8/8/4K3 b - - 0 1', 'b');
    expect(hanging.every((entry) => entry.type !== 'k')).toBe(true);
  });
});
