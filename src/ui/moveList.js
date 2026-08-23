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
  #buttons;
  #signature;

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
    /** Node id -> its button, for the navigation fast path. */
    this.#buttons = new Map();
    this.#signature = null;
  }

  #moveButton(node, currentId) {
    const quality = node.quality && QUALITY_META[node.quality];
    const symbol = quality?.symbol || node.nags.map((nag) => NAG_SYMBOLS[nag] ?? '').join('');
    const button = el(
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
    // Kept so the next navigation can move `aria-current` instead of rebuilding.
    this.#buttons.set(node.id, button);
    return button;
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
   * A cheap description of everything the printed list depends on, so a render
   * that would produce identical markup can be skipped. Anything that changes
   * the structure — a new move, a new variation, a re-graded move — changes
   * this; moving the cursor does not.
   */
  #describe(mainline) {
    const parts = [];
    for (const node of mainline) {
      parts.push(node.id, node.quality ?? '', node.nags.join(','), node.parent.children.length);
    }
    return parts.join('|');
  }

  /**
   * @param {import('../core/gameTree.js').GameTree} tree
   */
  render(tree) {
    const currentId = tree.current.id;
    const mainline = tree.mainline();

    // Navigating does not change what is printed, only which row is current.
    // Rebuilding the whole subtree and then reading layout in the same task is
    // a forced synchronous layout with a 100% hit rate, and it ran on every
    // move and every navigation step.
    const signature = this.#describe(mainline);
    if (signature === this.#signature && this.#buttons.has(currentId)) {
      this.#buttons.get(this.currentId)?.setAttribute('aria-current', 'false');
      this.#buttons.get(currentId)?.setAttribute('aria-current', 'true');
      this.currentId = currentId;
      this.scrollToCurrent();
      return;
    }

    this.currentId = currentId;
    this.#buttons.clear();
    this.#signature = signature;

    if (!mainline.length) {
      this.#signature = signature;
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
