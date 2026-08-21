import { describe, expect, it } from 'vitest';
import {
  calculateAnimations,
  fenToPosition,
  findClosestPiece,
  positionToFen,
  squareDistance,
} from '../../src/core/positionDiff.js';
import { SQUARES } from '../../src/core/constants.js';
import { START_FEN } from '../../src/core/constants.js';

describe('FEN conversion', () => {
  it('round-trips the start position', () => {
    const position = fenToPosition(START_FEN);
    expect(Object.keys(position)).toHaveLength(32);
    expect(position.e1).toBe('wK');
    expect(position.d8).toBe('bQ');
    expect(positionToFen(position)).toBe(START_FEN.split(' ')[0]);
  });

  it('round-trips every square of a sparse position', () => {
    const board = '4k3/8/8/3P4/8/8/8/R3K2R';
    expect(positionToFen(fenToPosition(board))).toBe(board);
  });

  it('rejects a malformed board field', () => {
    expect(() => fenToPosition('too/few/ranks')).toThrow();
  });
});

describe('squareDistance', () => {
  it('is the number of king moves between squares', () => {
    expect(squareDistance('a1', 'h8')).toBe(7);
    expect(squareDistance('e4', 'e5')).toBe(1);
    expect(squareDistance('e4', 'e4')).toBe(0);
    expect(squareDistance('a1', 'b3')).toBe(2);
  });

  it('is symmetric across every pair', () => {
    for (const a of SQUARES.slice(0, 12)) {
      for (const b of SQUARES) {
        expect(squareDistance(a, b)).toBe(squareDistance(b, a));
      }
    }
  });
});

describe('calculateAnimations', () => {
  const diff = (before, after) => calculateAnimations(fenToPosition(before), fenToPosition(after));

  it('turns a quiet move into a single slide', () => {
    expect(diff(START_FEN, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')).toEqual([
      { type: 'move', source: 'e2', destination: 'e4', piece: 'wP' },
    ]);
  });

  it('turns castling into two slides', () => {
    const animations = diff('r3k2r/8/8/8/8/8/8/R3K2R', 'r3k2r/8/8/8/8/8/8/R4RK1');
    expect(animations.filter((a) => a.type === 'move')).toHaveLength(2);
    expect(animations).toContainEqual({
      type: 'move',
      source: 'e1',
      destination: 'g1',
      piece: 'wK',
    });
    expect(animations).toContainEqual({
      type: 'move',
      source: 'h1',
      destination: 'f1',
      piece: 'wR',
    });
  });

  it('turns a capture into a slide plus a clear', () => {
    const animations = diff('8/8/8/3p4/4P3/8/8/8', '8/8/8/3P4/8/8/8/8');
    expect(animations).toContainEqual({
      type: 'move',
      source: 'e4',
      destination: 'd5',
      piece: 'wP',
    });
    expect(animations).toContainEqual({ type: 'clear', square: 'd5', piece: 'bP' });
  });

  it('turns promotion into a clear plus an add', () => {
    const animations = diff('8/4P3/8/8/8/8/8/8', '4Q3/8/8/8/8/8/8/8');
    // The pawn is gone and a queen has appeared; there is no piece to slide.
    expect(animations.some((a) => a.type === 'add' && a.piece === 'wQ')).toBe(true);
  });

  it('does nothing when nothing changed', () => {
    expect(diff(START_FEN, START_FEN)).toEqual([]);
  });

  it('prefers the nearest source when several pieces match', () => {
    const position = { a1: 'wR', h1: 'wR' };
    expect(findClosestPiece(position, 'wR', 'g1')).toBe('h1');
    expect(findClosestPiece(position, 'wR', 'b1')).toBe('a1');
    expect(findClosestPiece(position, 'wQ', 'e4')).toBeNull();
  });
});
