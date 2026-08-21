/**
 * What the engine is doing right now: depth, speed, score and its best line.
 *
 * Shown because a silent pause while the computer thinks reads as a hang. Depth
 * is capped in the display because Stockfish 5 reports runaway depths on forced
 * sequences — a mated position comes back claiming depth 120.
 */
import { el } from './dom.js';
import { formatEvaluation } from '../core/evaluation.js';

const DISPLAY_DEPTH_CAP = 40;

export class EnginePanel {
  constructor() {
    this.depth = el('span', { text: '—' });
    this.speed = el('span', { text: '' });
    this.score = el('span.engineinfo__score', { text: '—' });
    this.pv = el('div.engineinfo__pv', { text: '' });
    this.name = el('span', { text: '' });

    this.element = el('div.engineinfo', {}, [
      el('div.engineinfo__row', {}, [this.name, this.score]),
      el('div.engineinfo__row', {}, [this.depth, this.speed]),
      this.pv,
    ]);
  }

  setEngine(name, strength) {
    this.name.textContent = strength ? `${name} · ${strength}` : name;
  }

  /**
   * @param {object|null} info a normalised UCI info line
   * @param {'w'|'b'} turn whose move it is, so the score can be shown white-relative
   */
  update(info, turn = 'w') {
    if (!info) return this.clear();
    if (info.depth !== undefined) {
      this.depth.textContent = `depth ${Math.min(info.depth, DISPLAY_DEPTH_CAP)}`;
    }
    if (info.nps) {
      const knps = info.nps / 1000;
      this.speed.textContent =
        knps >= 1000 ? `${(knps / 1000).toFixed(1)}M n/s` : `${Math.round(knps)}k n/s`;
    }
    if (info.score) {
      const white = { ...info.score, value: turn === 'w' ? info.score.value : -info.score.value };
      this.score.textContent = formatEvaluation(white);
    }
    if (info.pv?.length) {
      // Lozza reports its PV in SAN; everything else in coordinates. Both are
      // readable, so show whichever arrived rather than pretending otherwise.
      this.pv.textContent = info.pv.slice(0, 8).join(' ');
    }
  }

  clear() {
    this.depth.textContent = '—';
    this.speed.textContent = '';
    this.score.textContent = '—';
    this.pv.textContent = '';
  }
}
