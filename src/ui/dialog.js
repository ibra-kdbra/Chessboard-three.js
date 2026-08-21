/**
 * Modal dialogs built on <dialog>.
 *
 * The native element gets focus trapping, Escape handling, inertness of the
 * page behind it and the top layer for free — all of which a hand-rolled modal
 * has to reimplement badly.
 */
import { el } from './dom.js';
import { GLYPH_FONT_STACK, PIECE_NAMES, pieceGlyph } from './pieceGlyphs.js';
import { PROMOTION_TYPES } from '../core/constants.js';

/**
 * @param {{ title: string, subtitle?: string, body?: Node|Node[],
 *           actions?: Array<{ label: string, value: any, variant?: string, autofocus?: boolean }>,
 *           dismissible?: boolean }} spec
 * @returns {Promise<any>} the chosen action's value, or null if dismissed
 */
export function showDialog({
  title,
  subtitle,
  body,
  actions = [],
  dismissible = true,
  closeSignal,
}) {
  const dialog = el('dialog.dialog', { 'aria-labelledby': 'dialog-title' });
  let settle;
  const answer = new Promise((resolve) => {
    settle = resolve;
  });

  const close = (value) => {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    settle(value);
  };

  dialog.append(
    el('div.dialog__head', {}, [
      el('h2.dialog__title#dialog-title', { text: title }),
      subtitle && el('p.dialog__subtitle', { text: subtitle }),
    ]),
    body ? el('div.dialog__body', {}, [body].flat()) : null,
    actions.length
      ? el(
          'div.dialog__foot',
          {},
          actions.map((action) =>
            el('button.button', {
              type: 'button',
              class:
                action.variant === 'primary'
                  ? 'button--primary'
                  : action.variant === 'danger'
                    ? 'button--danger'
                    : '',
              text: action.label,
              autofocus: action.autofocus,
              on: { click: () => close(action.value) },
            }),
          ),
        )
      : null,
  );

  // Escape and backdrop clicks are the same "no" as the cancel button.
  dialog.addEventListener('cancel', (event) => {
    if (!dismissible) {
      event.preventDefault();
      return;
    }
    close(null);
  });
  if (dismissible) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(null);
    });
  }

  // A progress dialog is dismissed by the work finishing, not by the reader.
  // Calling dialog.close() directly fires neither a click nor a cancel event,
  // so the promise would never settle and its awaiter would hang.
  if (closeSignal) {
    if (closeSignal.aborted) close(null);
    else closeSignal.addEventListener('abort', () => close(null), { once: true });
  }

  document.body.append(dialog);
  dialog.showModal();
  return answer;
}

/**
 * Asks which piece a pawn becomes.
 *
 * Always asked rather than read from a setting: promoting to a queen is right
 * almost always, and the times it is wrong are exactly the times it decides the
 * game. The old build had a "promote pawns to" dropdown and applied it silently.
 *
 * @param {'w'|'b'} color
 * @returns {Promise<'q'|'r'|'b'|'n'>}
 */
export function askPromotion(color) {
  return new Promise((resolve) => {
    const dialog = el('dialog.dialog', { 'aria-labelledby': 'promotion-title' });

    const choose = (type) => {
      if (!dialog.open) return;
      dialog.close();
      dialog.remove();
      resolve(type);
    };

    dialog.append(
      el('div.dialog__head', {}, [el('h2.dialog__title#promotion-title', { text: 'Promote to' })]),
      el('div.dialog__body', {}, [
        el(
          'div.promotion',
          {},
          PROMOTION_TYPES.map((type) =>
            el(
              'button.promotion__choice',
              {
                type: 'button',
                'aria-label': PIECE_NAMES[type],
                autofocus: type === 'q',
                on: { click: () => choose(type) },
              },
              [
                el('span', {
                  text: pieceGlyph(color, type),
                  style: { fontFamily: GLYPH_FONT_STACK, fontSize: '2.25rem', lineHeight: '1' },
                  'aria-hidden': 'true',
                }),
                PIECE_NAMES[type],
              ],
            ),
          ),
        ),
      ]),
    );

    // There is no cancelling a promotion — the move is already played. Escape
    // takes the queen, which is what the player almost certainly wanted.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      choose('q');
    });

    document.body.append(dialog);
    dialog.showModal();
  });
}
