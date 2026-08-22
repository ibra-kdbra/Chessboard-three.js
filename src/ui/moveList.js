/**
 * The notation panel.
 *
 * Renders the mainline in two columns with variations nested underneath the
 * move they branch from, which is how PGN reads and how players expect to see
 * an analysis. Clicking any move — mainline or variation — navigates there.
 */
import { el, replaceChildren } from './dom.js';
import { QUALITY_META } from '../core/evaluation.js';
import { NAG_SYMBOLS } from '../core/pgn.js';

export class MoveList {
  /** @param {{ onSelect: (nodeId: string) => void }} options */
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.element = el('div.movelist', {
      role: 'group',
      'aria-label': 'Moves',
      on: {
        click: (event) => {
          const button = event.target.closest('[data-node-id]');
          if (button) this.onSelect(button.dataset.nodeId);
        },
      },
    });
    this.currentId = null;
  }

  #moveButton(node, currentId) {
    const quality = node.quality && QUALITY_META[node.quality];
    const symbol = quality?.symbol || node.nags.map((nag) => NAG_SYMBOLS[nag] ?? '').join('');
    return el(
      'button.movelist__move',
      {
        type: 'button',
        // No role override: role="listitem" replaced the implicit button role,
        // so a screen reader announced each move as inert text and none of them
        // appeared when listing the page's controls.
        dataset: { nodeId: node.id },
        'aria-current': String(node.id === currentId),
        title: quality?.label ?? '',
      },
      [
        node.move.san,
        symbol &&
          el('span.movelist__quality', {
            text: symbol,
            dataset: { quality: node.quality ?? '' },
          }),
      ],
    );
  }

  /** Flattens a variation into inline `1. e4 e5 2. Nf3` text with clickable moves. */
  #variationLine(start, currentId) {
    const parts = [];
    let node = start;
    let needsNumber = true;
    while (node) {
      if (node.color === 'w') parts.push(`${node.moveNumber}.`);
      else if (needsNumber) parts.push(`${node.moveNumber}...`);
      needsNumber = false;
      parts.push(this.#moveButton(node, currentId));
      // Only the variation's own mainline is shown inline; deeper branches are
      // reachable by navigating into them.
      node = node.children[0];
    }
    return parts;
  }

  /**
   * @param {import('../core/gameTree.js').GameTree} tree
   */
  render(tree) {
    const currentId = tree.current.id;
    this.currentId = currentId;
    const mainline = tree.mainline();

    if (!mainline.length) {
      replaceChildren(
        this.element,
        el('p.movelist__empty', {
          text: 'Play a move on the board, or type it — e4, Nf3, O-O — and press Enter.',
        }),
      );
      return;
    }

    const rows = [];
    for (let i = 0; i < mainline.length; i += 2) {
      const white = mainline[i];
      const black = mainline[i + 1];
      rows.push(el('span.movelist__number', { text: `${white.moveNumber}.` }));
      rows.push(this.#moveButton(white, currentId));
      rows.push(
        black
          ? this.#moveButton(black, currentId)
          : el('span.movelist__move', { dataset: { empty: 'true' }, text: '…' }),
      );

      // Variations hang off the position their parent was played from, so they
      // are printed after the row containing that parent.
      for (const node of [white, black].filter(Boolean)) {
        const siblings = node.parent.children.slice(1);
        for (const sibling of siblings) {
          rows.push(
            el('div.movelist__variations', {}, [
              '(',
              ...this.#variationLine(sibling, currentId),
              ')',
            ]),
          );
        }
      }
    }
    replaceChildren(this.element, rows);
    this.scrollToCurrent();
  }

  scrollToCurrent() {
    const current = this.element.querySelector('[aria-current="true"]');
    current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
