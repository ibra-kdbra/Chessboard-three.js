import { describe, expect, it } from 'vitest';
import { GameTree } from '../../src/core/gameTree.js';

/**
 * The move list skips a rebuild when the markup would be identical. That
 * signature has to describe everything the list actually prints, or the list
 * keeps showing moves the tree no longer holds — still clickable, and clicking
 * them does nothing.
 *
 * The signature function is private, so this reconstructs it: the property
 * under test is that the printed shape and the signature change together.
 */

/** Mirrors MoveList#describe. */
function describe_(mainline) {
  const parts = [];
  const push = (node) => parts.push(node.id, node.quality ?? '', node.nags.join(','));
  for (const node of mainline) {
    push(node);
    for (const sibling of node.parent.children.slice(1)) {
      for (let step = sibling; step; step = step.children[0]) push(step);
      parts.push(')');
    }
  }
  return parts.join('|');
}

/** Every node the list prints: the mainline plus each variation's own line. */
function printed(tree) {
  const ids = [];
  for (const node of tree.mainline()) {
    ids.push(node.id);
    for (const sibling of node.parent.children.slice(1)) {
      for (let step = sibling; step; step = step.children[0]) ids.push(step.id);
    }
  }
  return ids;
}

/** 1. e4 e5, with 1... c5 2. Nf3 as a variation off 1. e4. */
function withVariation() {
  const move = (san) => ({ san, from: 'a1', to: 'a2' });
  const tree = new GameTree('start');
  const e4 = tree.addMove(move('e4'), 'f1');
  tree.addMove(move('e5'), 'f2');
  tree.goTo(e4);
  const c5 = tree.addMove(move('c5'), 'f3');
  tree.addMove(move('Nf3'), 'f4');
  tree.goTo(c5);
  return tree;
}

describe('the move-list skip signature', () => {
  it('is stable across pure navigation', () => {
    const tree = withVariation();
    const before = describe_(tree.mainline());
    tree.goTo(tree.root.id);
    expect(describe_(tree.mainline())).toBe(before);
  });

  it('changes when a move is removed from inside a variation', () => {
    const tree = withVariation();
    const before = describe_(tree.mainline());
    const beforePrinted = printed(tree);

    // Drop the deepest variation move — the case a sibling count cannot see.
    const deepest = beforePrinted[beforePrinted.length - 1];
    tree.remove(tree.findById(deepest));

    expect(printed(tree)).not.toEqual(beforePrinted);
    expect(describe_(tree.mainline()), 'signature must follow the printed shape').not.toBe(before);
  });

  it('changes when a move is re-graded', () => {
    const tree = withVariation();
    const before = describe_(tree.mainline());
    tree.mainline()[0].quality = 'blunder';
    expect(describe_(tree.mainline())).not.toBe(before);
  });
});
