/**
 * The one time this asks to be starred.
 *
 * Rules it follows, because a badly-timed ask costs more goodwill than a star
 * is worth:
 *
 * - It is earned, not assumed. Nothing appears until someone has played three
 *   games all the way to a result. By then they have an opinion worth asking
 *   for; on the first load they do not.
 * - It never blocks. This is a strip in the panel, not a modal over the board,
 *   and the game keeps running behind it.
 * - It asks once in a lifetime. Accepted or declined, the answer is remembered
 *   and it never appears again.
 * - Declining is as easy as accepting. Both are real buttons, the same size,
 *   next to each other.
 * - It does not lie. No invented star counts, no "everyone else did".
 */
import { el } from './dom.js';
import { icon } from './icons.js';

/** Finished games before the ask. Three is enough to have formed a view. */
export const GAMES_BEFORE_ASKING = 3;

export class StarPrompt {
  /**
   * @param {object} options
   * @param {string} options.url the repository to star
   * @param {() => void} options.onAnswer called once, whichever way it goes
   */
  constructor({ url, onAnswer }) {
    this.url = url;
    this.onAnswer = onAnswer;
    this.element = el('div.starprompt', { hidden: true });
  }

  /** Builds and reveals the strip. Safe to call more than once. */
  show() {
    if (!this.element.hidden) return;

    const link = el('a.button.button--primary.starprompt__accept', {
      href: this.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'Star on GitHub',
    });
    link.prepend(icon('star', 16));
    link.addEventListener('click', () => this.#answer());

    const dismiss = el('button.button.button--quiet', {
      type: 'button',
      text: 'No thanks',
      on: { click: () => this.#answer() },
    });

    this.element.replaceChildren(
      el('p.starprompt__text', {
        text: 'Three games in. If Boxwood is worth keeping, a star helps other people find it.',
      }),
      el('div.starprompt__actions', {}, [dismiss, link]),
    );
    this.element.setAttribute('role', 'complementary');
    this.element.setAttribute('aria-label', 'Support this project');
    this.element.hidden = false;
  }

  #answer() {
    this.element.hidden = true;
    this.element.replaceChildren();
    this.onAnswer();
  }
}
