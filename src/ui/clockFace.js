/**
 * One player's clock, name and captured pieces.
 */
import { el } from './dom.js';
import { formatTime } from '../core/clock.js';
import { GLYPH_FONT_STACK, pieceGlyph } from './pieceGlyphs.js';

export class ClockFace {
  /** @param {{ color: 'w'|'b', name?: string }} options */
  constructor({ color, name = color === 'w' ? 'White' : 'Black' }) {
    this.color = color;
    this.time = el('div.clock__time', { text: '—' });
    this.nameEl = el('span.clock__name', { text: name });
    this.tray = el('div.tray', { 'aria-label': `Pieces captured by ${name}` });
    this.balance = el('span.tray__balance');

    this.element = el('div.clock', { dataset: { active: 'false' } }, [
      el('div.clock__who', {}, [el('span.clock__dot', { dataset: { color } }), this.nameEl]),
      this.time,
    ]);

    this.container = el('div', { style: { display: 'grid', gap: 'var(--space-1)' } }, [
      this.element,
      el('div.tray', { style: { paddingLeft: 'var(--space-1)' } }, [this.tray, this.balance]),
    ]);
  }

  setName(name) {
    this.nameEl.textContent = name;
  }

  /** @param {number|null} ms null renders as untimed */
  setTime(ms, { active = false, lowTimeMs = 30_000, flagged = false } = {}) {
    this.time.textContent = formatTime(ms);
    // Untimed is the default time control, and two boxes rendering an infinity
    // sign were taking the top quarter of the panel to say nothing. The row
    // still marks whose turn it is; it just stops reserving space for a clock
    // that does not exist.
    this.element.dataset.untimed = String(ms === null);
    this.element.dataset.active = String(active);
    this.element.dataset.low = String(ms !== null && ms <= lowTimeMs);
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
