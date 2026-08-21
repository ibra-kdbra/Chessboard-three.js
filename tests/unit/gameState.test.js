import { describe, expect, it } from 'vitest';
import { GameState } from '../../src/core/gameState.js';

const play = (state, sans) => sans.forEach((san) => state.move(san));

describe('GameState', () => {
  it('detects checkmate and names the winner', () => {
    const state = new GameState();
    play(state, ['e4', 'e5', 'Bc4', 'Bc5', 'Qh5', 'Nf6', 'Qxf7#']);

    expect(state.isCheckmate).toBe(true);
    expect(state.result()).toMatchObject({
      over: true,
      winner: 'w',
      reason: 'checkmate',
      scoreString: '1-0',
    });
  });

  it('distinguishes the drawing rules', () => {
    expect(new GameState({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' }).result().reason).toBe(
      'stalemate',
    );
    expect(new GameState({ fen: '7k/8/6K1/8/8/8/8/8 w - - 0 1' }).result().reason).toBe(
      'insufficient-material',
    );
    expect(new GameState({ fen: '4k3/8/4K3/8/8/8/8/6R1 w - - 99 60' }).result().over).toBe(false);
  });

  it('rejects illegal moves without changing the position', () => {
    const state = new GameState();
    const fen = state.fen;
    expect(state.move('e5')).toBeNull();
    expect(state.fen).toBe(fen);
    expect(state.ply).toBe(0);
  });

  it('reports captured material and the balance from the position', () => {
    const state = new GameState();
    play(state, ['e4', 'd5', 'exd5']);
    const material = state.material();

    expect(material.w).toEqual(['p']);
    expect(material.b).toEqual([]);
    expect(material.balance).toBe(1);
  });

  it('counts promotions rather than reporting a negative capture', () => {
    // Four white queens. Black really is missing its queen, so white's tray
    // shows one; white is not missing three queens, it has three extra, and
    // black's tray must not show a phantom -3.
    const state = new GameState({ fen: '8/8/8/8/8/8/8/QQQQK2k w - - 0 1' });
    const material = state.material();

    expect(material.w.filter((piece) => piece === 'q')).toEqual(['q']);
    expect(material.b).not.toContain('q');
    expect(material.balance).toBe(36);
  });

  it('keeps the rules engine in step when navigating', () => {
    const state = new GameState();
    play(state, ['e4', 'e5', 'Nf3', 'Nc6']);

    state.toStart();
    expect(state.turn).toBe('w');
    expect(state.legalMoves('e2')).toHaveLength(2);

    state.toEnd();
    expect(state.ply).toBe(4);
    expect(state.turn).toBe('w');
  });

  it('starts a variation when a move is played from a reviewed position', () => {
    const state = new GameState();
    play(state, ['e4', 'e5']);
    state.back();
    state.move('c5');

    expect(state.tree.root.children[0].children.map((n) => n.move.san)).toEqual(['e5', 'c5']);
    expect(state.tree.mainline().map((n) => n.move.san)).toEqual(['e4', 'e5']);
  });

  it('knows when a promotion choice is required', () => {
    const state = new GameState({ fen: '8/4P3/8/8/8/8/8/K6k w - - 0 1' });
    expect(state.needsPromotion('e7', 'e8')).toBe(true);

    const quiet = new GameState();
    expect(quiet.needsPromotion('e2', 'e4')).toBe(false);
  });

  it('records resignation, which the rules engine cannot represent', () => {
    const state = new GameState();
    play(state, ['e4', 'e5']);
    const result = state.adjudicate('resignation', 'b');

    expect(result).toMatchObject({ over: true, winner: 'b', scoreString: '0-1' });
    expect(state.isFinished).toBe(true);
  });

  it('round-trips through JSON', () => {
    const state = new GameState();
    play(state, ['d4', 'd5', 'c4', 'e6']);
    const restored = GameState.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));

    expect(restored.tree.mainline().map((n) => n.move.san)).toEqual(['d4', 'd5', 'c4', 'e6']);
    expect(restored.fen).toBe(state.fen);
  });
});
