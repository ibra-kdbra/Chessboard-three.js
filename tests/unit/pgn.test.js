import { describe, expect, it } from 'vitest';
import { parsePgn, writePgn } from '../../src/core/pgn.js';
import { GameState } from '../../src/core/gameState.js';

const SAMPLE = `[Event "Test"]
[Site "?"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 {[%eval 0.31] a good start} e5 (1... c5 {Sicilian} 2. Nf3 d6) 2. Nf3 $1 Nc6 3. Bb5 1-0
`;

describe('PGN', () => {
  it('parses headers, mainline, variations, comments and NAGs', () => {
    const { tree, headers, result } = parsePgn(SAMPLE);

    expect(headers.Event).toBe('Test');
    expect(result).toBe('1-0');
    expect(tree.mainline().map((n) => n.move.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);

    const e4 = tree.root.children[0];
    expect(e4.comment).toBe('a good start');
    expect(e4.evaluation).toEqual({ type: 'cp', value: 31, depth: null });
    expect(e4.children.map((n) => n.move.san)).toEqual(['e5', 'c5']);

    const sicilian = e4.children[1];
    expect([sicilian, ...sicilian.mainlineBelow()].map((n) => n.move.san)).toEqual([
      'c5',
      'Nf3',
      'd6',
    ]);
    expect(tree.mainline()[2].nags).toEqual([1]);
  });

  it('does not mistake a bracketed command inside a comment for a tag pair', () => {
    // The header block ends at the first non-tag line, and `[%eval ...]` sits
    // inside braces. Scanning for the last `]` in the file lands inside it.
    const { tree } = parsePgn(SAMPLE);
    expect(tree.mainline()).toHaveLength(5);
  });

  it('round-trips a tree without losing variations or annotations', () => {
    const { tree, headers, result } = parsePgn(SAMPLE);
    const written = writePgn(tree, { headers, result });
    const again = parsePgn(written);

    expect(again.tree.mainline().map((n) => n.move.san)).toEqual(
      tree.mainline().map((n) => n.move.san),
    );
    const variation = again.tree.root.children[0].children[1];
    expect([variation, ...variation.mainlineBelow()].map((n) => n.move.san)).toEqual([
      'c5',
      'Nf3',
      'd6',
    ]);
    expect(again.tree.root.children[0].evaluation.value).toBe(31);
    expect(again.result).toBe('1-0');
  });

  it('restates the move number after a variation closes', () => {
    const { tree, headers, result } = parsePgn(SAMPLE);
    const written = writePgn(tree, { headers, result });
    // Without the restatement, `2. Nf3` after `(1... c5 2. Nf3 d6)` reads as a
    // continuation of the variation.
    expect(written).toMatch(/\)\s*2\.\s*Nf3/);
  });

  it('carries a non-standard starting position through the FEN tag', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 3';
    const state = new GameState({ fen });
    state.move('Nf6');

    const written = state.pgn();
    expect(written).toContain('[SetUp "1"]');
    expect(written).toContain(`[FEN "${fen}"]`);

    const reloaded = new GameState();
    reloaded.loadPgn(written);
    expect(reloaded.tree.startFen).toBe(fen);
    expect(reloaded.tree.mainline().map((n) => n.move.san)).toEqual(['Nf6']);
  });

  it('rejects movetext containing an illegal move', () => {
    // A knight on g1 cannot reach f6 on move two.
    expect(() => parsePgn('[Event "x"]\n\n1. e4 e5 2. Nf6 1-0')).toThrow(/illegal move/);
  });

  it('accepts 0-0 as well as O-O', () => {
    // Both sides must actually be able to castle, so the knight leaves g8 too.
    const { tree } = parsePgn('[Event "x"]\n\n1. e4 e5 2. Nf3 Nf6 3. Bc4 Bc5 4. 0-0 0-0 *');
    expect(
      tree
        .mainline()
        .map((n) => n.move.san)
        .filter((san) => san === 'O-O'),
    ).toHaveLength(2);
  });
});
