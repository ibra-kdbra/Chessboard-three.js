/**
 * The evaluation bar beside the board.
 *
 * Height is driven by expected score rather than raw centipawns, so the bar
 * moves the way a player's sense of the position moves: the difference between
 * +0.2 and +1.5 is enormous, between +8 and +9 it is nothing.
 */
import { el } from './dom.js';
import { evaluationToBar, formatEvaluation } from '../core/evaluation.js';

export class EvalBar {
  /** @param {{ orientation?: 'white'|'black' }} [options] */
  constructor({ orientation = 'white' } = {}) {
    this.orientation = orientation;
    this.white = el('div.evalbar__white');
    this.value = el('div.evalbar__value', { dataset: { side: 'bottom' }, text: '0.0' });
    this.element = el(
      'div.evalbar',
      {
        role: 'meter',
        'aria-label': 'Evaluation',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '50',
        'aria-valuetext': 'Equal',
      },
      [this.white, el('div.evalbar__mid'), this.value],
    );
    this.set(null);
  }

  /** @param {{type:'cp'|'mate', value:number}|null} evaluation white's point of view */
  set(evaluation) {
    const share = evaluationToBar(evaluation);
    // The bar always fills from the bottom of the board towards the top, and
    // the board can be flipped, so the share has to flip with it.
    const whiteShare = this.orientation === 'white' ? share : 1 - share;
    this.white.style.transform = `scaleY(${whiteShare.toFixed(4)})`;

    // No sign: which side is ahead is already shown by where the divider sits,
    // and the column is only wide enough for four characters.
    const text = evaluation ? formatEvaluation(evaluation, { alwaysSign: false }) : '0.0';
    this.value.textContent = text;
    // Keep the number on whichever side has room for it.
    this.value.dataset.side = whiteShare > 0.5 ? 'bottom' : 'top';

    // The meter reports what the viewer sees, so it flips with the board.
    this.element.setAttribute('aria-valuenow', String(Math.round(whiteShare * 100)));
    this.element.setAttribute(
      'aria-valuetext',
      evaluation
        ? `${formatEvaluation(evaluation)} for ${evaluation.value >= 0 ? 'White' : 'Black'}`
        : 'Equal',
    );
  }

  setOrientation(orientation) {
    this.orientation = orientation;
  }
}
