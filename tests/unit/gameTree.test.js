import { describe, expect, it } from 'vitest';
import { GameTree } from '../../src/core/gameTree.js';

const move = (san) => ({ san, from: 'a1', to: 'a2' });

describe('GameTree', () => {
  it('treats the first child as the mainline and the rest as variations', () => {
    const tree = new GameTree('start');
    const e4 = tree.addMove(move('e4'), 'f1');
    tree.addMove(move('e5'), 'f2');
    tree.goTo(e4);
    const c5 = tree.addMove(move('c5'), 'f3');

    expect(tree.mainline().map((n) => n.move.san)).toEqual(['e4', 'e5']);
    expect(c5.isMainline).toBe(false);
    expect(e4.children).toHaveLength(2);
  });

  it('reuses an existing node when the same move is replayed', () => {
    const tree = new GameTree('start');
    const first = tree.addMove(move('e4'), 'f1');
    tree.toStart();
    const again = tree.addMove(move('e4'), 'f1');

    expect(again).toBe(first);
    expect(tree.root.children).toHaveLength(1);
  });

  it('promotes a variation to the mainline', () => {
    const tree = new GameTree('start');
    const e4 = tree.addMove(move('e4'), 'f1');
    tree.addMove(move('e5'), 'f2');
    tree.goTo(e4);
    const c5 = tree.addMove(move('c5'), 'f3');

    tree.promote(c5);
    expect(tree.mainline().map((n) => n.move.san)).toEqual(['e4', 'c5']);
    expect(c5.isMainline).toBe(true);
  });

  it('numbers moves and assigns colours from the ply', () => {
    const tree = new GameTree('start');
    const e4 = tree.addMove(move('e4'), 'f1');
    const e5 = tree.addMove(move('e5'), 'f2');
    const nf3 = tree.addMove(move('Nf3'), 'f3');

    expect([e4.moveNumber, e5.moveNumber, nf3.moveNumber]).toEqual([1, 1, 2]);
    expect([e4.color, e5.color, nf3.color]).toEqual(['w', 'b', 'w']);
  });

  it('falls back to the parent when the branch being viewed is removed', () => {
    const tree = new GameTree('start');
    const e4 = tree.addMove(move('e4'), 'f1');
    const e5 = tree.addMove(move('e5'), 'f2');

    tree.remove(e5);
    expect(tree.current).toBe(e4);
    expect(tree.size).toBe(1);
  });

  it('refuses to remove the root', () => {
    const tree = new GameTree('start');
    expect(() => tree.remove(tree.root)).toThrow();
  });

  it('round-trips through JSON, variations and annotations included', () => {
    const tree = new GameTree('start', { Event: 'Test' });
    const e4 = tree.addMove(move('e4'), 'f1');
    e4.comment = 'best by test';
    e4.nags = [1];
    e4.evaluation = { type: 'cp', value: 31, depth: 12 };
    tree.addMove(move('e5'), 'f2');
    tree.goTo(e4);
    tree.addMove(move('c5'), 'f3');

    const restored = GameTree.fromJSON(JSON.parse(JSON.stringify(tree.toJSON())));

    expect(restored.headers).toEqual({ Event: 'Test' });
    expect(restored.mainline().map((n) => n.move.san)).toEqual(['e4', 'e5']);
    expect(restored.root.children[0].children.map((n) => n.move.san)).toEqual(['e5', 'c5']);
    expect(restored.root.children[0].comment).toBe('best by test');
    expect(restored.root.children[0].evaluation).toEqual({ type: 'cp', value: 31, depth: 12 });
    expect(restored.current.move.san).toBe('c5');
  });

  it('forward() follows the line being viewed, not the game mainline', () => {
    const tree = new GameTree('start');
    const e4 = tree.addMove(move('e4'), 'f1');
    tree.addMove(move('e5'), 'f2');
    tree.goTo(e4);
    const c5 = tree.addMove(move('c5'), 'f3');
    tree.addMove(move('Nf3'), 'f4');

    tree.goTo(c5);
    expect(tree.forward().move.san).toBe('Nf3');
  });
});
