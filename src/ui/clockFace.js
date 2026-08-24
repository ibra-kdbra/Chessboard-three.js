/**
 * One player's row in the match band: side, name, what they have taken, and
 * their clock.
 *
 * It used to be a bordered card with the captured pieces on a second line
 * underneath. Two of those cost 177px at the top of a 336px panel — a quarter
 * of the column — and on the default time control both of them were showing
 * nothing but a name. It is one row now, and the tray sits on it.
 */
import { el } from './dom.js';
import { formatTime } from '../core/clock.js';
import { GLYPH_FONT_STACK, pieceGlyph } from './pieceGlyphs.js';

export class ClockFace {
  /** @param {{ color: 'w'|'b', name?: string }} options */
  constructor({ color, name = color === 'w' ? 'White' : 'Black' }) {
    this.color = color;
    this.time = el('div.matchrow__time', { text: '—' });
    this.nameEl = el('span.matchrow__name', { text: name });
    this.tray = el('div.tray', { 'aria-label': `Pieces captured by ${name}` });
    this.balance = el('span.tray__balance');

    this.element = el('div.matchrow', { dataset: { active: 'false' } }, [
      el('span.matchrow__dot', { dataset: { color } }),
      this.nameEl,
      this.tray,
      this.balance,
      this.time,
    ]);
  }

  setName(name) {
    this.nameEl.textContent = name;
  }

  /** @param {number|null} ms null renders as untimed */
  setTime(ms, { lowTimeMs = 30_000 } = {}) {
    this.time.textContent = formatTime(ms);
    // Untimed is the default time control, and a row reserving space for a
    // clock that does not exist is space the move list needs. The row still
    // marks whose turn it is.
    this.element.dataset.untimed = String(ms === null);
    this.element.dataset.low = String(ms !== null && ms <= lowTimeMs);
  }

  /**
   * Lights the row for the side to move.
   *
   * Whose turn it is, not whose clock is ticking. They are the same thing in a
   * timed game and not the same thing at all in the default one: an untimed
   * clock never starts, so this was read from `running` and came back null on
   * every move of every game most people play. Neither row ever lit up.
   *
   * @param {boolean} active
   * @param {boolean} [flagged] this side lost on time
   */
  setActive(active, flagged = false) {
    this.element.dataset.active = String(active);
    this.element.dataset.flagged = String(flagged);
  }

  /**
   * @param {string[]} captured piece types this player has taken
   * @param {number} balance material difference, positive when this side leads
   */
  setCaptured(captured, balance) {
    const enemy = this.color === 'w' ? 'b' : 'w';
    this.tray.replaceChildren(
      ...captured.map((type) =>
        el('span.tray__piece', {
          text: pieceGlyph(enemy, type),
          style: { fontFamily: GLYPH_FONT_STACK, lineHeight: '1' },
          'aria-hidden': 'true',
        }),
      ),
    );
    this.balance.textContent = balance > 0 ? `+${balance}` : '';
  }
}
