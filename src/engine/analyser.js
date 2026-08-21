/**
 * Continuous analysis.
 *
 * The usual way to do this — `go infinite` plus `stop` when the position
 * changes — is unavailable here: every bundled engine searches on its worker's
 * own event loop, so a `stop` sits unread until the search it was meant to
 * interrupt has already finished. So instead of one long search this pumps a
 * queue of short bounded ones, deepening while the position holds still and
 * abandoning the queue the moment it changes.
 *
 * It runs on its own engine instance, on its own worker, so analysing never
 * competes with the opponent for a search slot.
 */
import { Emitter } from '../core/emitter.js';
import { UciEngine } from './uciEngine.js';

/** Successive budgets for one position, in ms. Short first, so the bar moves. */
const LADDER = [120, 300, 700, 1400, 2400];

/**
 * Events: `evaluation` ({ fen, evaluation, depth, pv, best }), `busy`, `idle`.
 */
export class Analyser extends Emitter {
  /**
   * @param {{ profile?: string, workerFactory?: (url: string) => Worker,
   *           multiPv?: number }} [options]
   */
  constructor({ profile = 'lozza', workerFactory, multiPv = 1 } = {}) {
    super();
    this.engine = new UciEngine({ profile, workerFactory });
    this.multiPv = multiPv;
    this.enabled = false;
    /** FEN currently being analysed, or queued next. */
    this.target = null;
    this.running = false;
    this.lastResult = null;
  }

  async start() {
    await this.engine.start();
    await this.engine.newGame();
    return this;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.target = null;
      this.engine.cancel().catch(() => {});
      this.emit('idle', {});
    }
  }

  /**
   * Points the analyser at a position. Safe to call on every move — a position
   * that arrives mid-pump simply replaces the target and the pump restarts.
   */
  analyse(fen, { turn = 'w' } = {}) {
    if (!this.enabled) return;
    if (fen === this.target) return;
    this.target = fen;
    this.turn = turn;
    if (!this.running) this.#pump();
  }

  async #pump() {
    this.running = true;
    this.emit('busy', {});
    try {
      while (this.enabled && this.target) {
        const fen = this.target;
        let deepest = null;

        for (const movetime of LADDER) {
          // The position changed while we were thinking: drop this ladder and
          // start again on the new one.
          if (fen !== this.target || !this.enabled) break;
          let result;
          try {
            result = await this.engine.search(fen, { movetime, multiPv: this.multiPv });
          } catch {
            // Cancelled or timed out; the next loop decides what to do next.
            break;
          }
          if (fen !== this.target) break;
          if (!result.info?.score) continue;

          // Engine scores are side-to-move relative; publish white-relative.
          const sign = this.turn === 'w' ? 1 : -1;
          deepest = {
            fen,
            evaluation: { ...result.info.score, value: result.info.score.value * sign },
            depth: result.info.depth ?? null,
            pv: result.lines[0]?.pv ?? null,
            pvFormat: result.lines[0]?.pvFormat ?? 'uci',
            best: result.bestmove,
            lines: result.lines,
          };
          this.lastResult = deepest;
          this.emit('evaluation', deepest);
        }

        // Fully deepened on a position that is still current: nothing more to do
        // until it changes.
        if (fen === this.target) {
          this.target = null;
        }
      }
    } finally {
      this.running = false;
      this.emit('idle', {});
    }
  }

  /**
   * Evaluates every position in a line and writes the results onto the nodes.
   *
   * This is what makes a post-game review mean anything: without it the only
   * evaluations on record are the ones the opponent happened to produce for its
   * own moves, so half the game has no score and the accuracy figure is built
   * on nothing.
   *
   * @param {Array<import('../core/gameTree.js').GameNode>} nodes mainline, in order
   * @param {{ movetime?: number, onProgress?: (done: number, total: number) => void,
   *           signal?: AbortSignal, rootFen?: string, root?: object }} [options]
   * @returns {Promise<boolean>} false if it was cancelled part way
   */
  async reviewLine(nodes, { movetime = 260, onProgress, signal, rootFen, root } = {}) {
    // Pause live analysis: two searches racing on one worker would serialise
    // anyway, and the pump would keep re-targeting the position on screen.
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.target = null;
    await this.engine.cancel().catch(() => {});

    const positions = [];
    if (rootFen && root) positions.push({ node: root, fen: rootFen, turn: 'w' });
    for (const node of nodes) {
      positions.push({ node, fen: node.fen, turn: node.color === 'w' ? 'b' : 'w' });
    }

    try {
      for (const [index, entry] of positions.entries()) {
        if (signal?.aborted) return false;
        let result;
        try {
          result = await this.engine.search(entry.fen, { movetime });
        } catch {
          return false;
        }
        if (result.info?.score) {
          const sign = entry.turn === 'w' ? 1 : -1;
          entry.node.evaluation = {
            ...result.info.score,
            value: result.info.score.value * sign,
          };
          entry.node.pv = result.lines[0]?.pv ?? null;
        }
        onProgress?.(index + 1, positions.length);
      }
      return true;
    } finally {
      this.enabled = wasEnabled;
    }
  }

  dispose() {
    this.enabled = false;
    this.target = null;
    this.engine.dispose();
    this.removeAllListeners();
  }
}
