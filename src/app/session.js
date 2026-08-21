/**
 * The session: what turns the pieces into a game.
 *
 * Owns the game state, the clock, the engine and whose turn it is to be asked
 * for a move. Everything else — renderers, panels — observes it. It touches no
 * DOM itself, so the same object drives the 3D board, the 2D board and the
 * notation panel without knowing any of them exist.
 *
 * Events: `change` (position moved), `move`, `status`, `thinking`, `evaluation`,
 * `gameover`, `clock`, `illegal`.
 */
import { Emitter } from '../core/emitter.js';
import { GameState } from '../core/gameState.js';
import { Clock, timeControlById } from '../core/clock.js';
import { identifyOpening } from '../core/openings.js';
import { UciEngine, parseUciMove } from '../engine/uciEngine.js';
import { getEngineProfile } from '../engine/engineProfiles.js';
import { Opponent } from '../engine/opponent.js';
import { START_FEN, opposite } from '../core/constants.js';

export const MODES = Object.freeze({
  engine: { id: 'engine', name: 'Play the computer' },
  hotseat: { id: 'hotseat', name: 'Two players' },
  analysis: { id: 'analysis', name: 'Analysis' },
});

export class Session extends Emitter {
  /**
   * @param {{ settings: object, workerFactory?: (url: string) => Worker }} options
   */
  constructor({ settings, workerFactory } = {}) {
    super();
    this.settings = { ...settings };
    this.workerFactory = workerFactory;
    this.mode = 'engine';
    this.state = new GameState({ fen: START_FEN });
    this.playerColor = this.settings.playerColor ?? 'w';
    this.clock = this.#buildClock();
    this.engine = null;
    this.opponent = null;
    this.thinking = false;
    this.lastMove = null;
    this.pendingSearch = null;
    /** A move queued while the engine is still thinking. */
    this.premove = null;
    this.#wireState();
  }

  #moveStartedAt = 0;
  /** Why the engine is busy: 'opponent' or 'hint'. They are handled differently. */
  thinkingReason = null;

  #buildClock() {
    const control = timeControlById(this.settings.timeControl ?? 'unlimited');
    const clock = new Clock({
      initial: control.initial,
      increment: control.increment,
      now: () => performance.now(),
    });
    clock.on('flag', ({ color }) => {
      this.state.adjudicate('timeout', opposite(color));
      this.emit('gameover', this.state.result());
    });
    clock.on('tick', (snapshot) => this.emit('clock', snapshot));
    clock.on('lowtime', (payload) => this.emit('lowtime', payload));
    return clock;
  }

  #wireState() {
    this.state.on('move', ({ move, node }) => {
      this.lastMove = move;
      this.emit('move', { move, node });
    });
    this.state.on('change', (payload) => this.emit('change', payload));
    this.state.on('gameover', (result) => this.#finish(result));
  }

  // ------------------------------------------------------------------ setup

  /** Boots (or replaces) the engine worker. */
  async useEngine(id) {
    const profile = getEngineProfile(id);
    this.engine?.dispose();
    this.engine = new UciEngine({ profile, workerFactory: this.workerFactory });
    this.engine.on('info', (info) => {
      if (this.thinking) this.emit('evaluation', { info, turn: this.state.turn });
    });
    await this.engine.start();
    await this.engine.newGame();
    this.opponent = new Opponent({ engine: this.engine, level: this.settings.difficulty ?? 5 });
    this.settings.engine = profile.id;
    this.emit('engine', { profile, capabilities: this.engine.capabilities });
    return this.engine;
  }

  setDifficulty(level) {
    this.settings.difficulty = level;
    this.opponent?.setLevel(level);
    this.emit('status', this.status());
  }

  setTimeControl(id) {
    this.settings.timeControl = id;
    const control = timeControlById(id);
    this.clock.reset({ initial: control.initial, increment: control.increment });
    this.emit('status', this.status());
  }

  setMode(mode) {
    this.mode = MODES[mode] ? mode : 'engine';
    this.emit('status', this.status());
  }

  // ------------------------------------------------------------- game flow

  /**
   * Starts a fresh game.
   * @param {{ fen?: string, color?: 'w'|'b'|'random', mode?: string }} [options]
   */
  async newGame({ fen = START_FEN, color = this.playerColor, mode = this.mode } = {}) {
    await this.cancelThinking();
    this.mode = mode;
    this.playerColor = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    this.settings.playerColor = this.playerColor;
    this.state = new GameState({ fen });
    this.#wireState();
    this.clock.reset();
    this.lastMove = null;
    this.premove = null;
    this.#moveStartedAt = performance.now();

    await this.engine?.newGame();
    this.startClock();
    this.emit('change', { node: this.state.node, reason: 'newgame' });
    this.emit('status', this.status());
    // If the human is black, the computer opens.
    await this.maybePlayEngineMove();
    return this.state;
  }

  /**
   * Starts the side-to-move's clock.
   *
   * Clocks were only ever pressed *after* a move, so the first move of every
   * timed game was free — and a restored game resumed with both clocks stopped.
   */
  startClock() {
    if (this.clock.isUntimed || this.state.isFinished) return;
    this.clock.press(this.state.turn);
  }

  /** True when the side to move is the human's. */
  get isPlayerTurn() {
    if (this.mode === 'hotseat' || this.mode === 'analysis') return true;
    return this.state.turn === this.playerColor;
  }

  /** True when a move may be entered right now. */
  get canMove() {
    return !this.state.isFinished && !this.thinking && !this.state.isReviewing;
  }

  /**
   * Plays a human move.
   * @param {{from: string, to: string, promotion?: string}|string} move
   * @returns {Promise<object|null>} the move, or null if it was rejected
   */
  async play(move) {
    if (this.state.isFinished) return null;
    if (this.thinking) {
      if (this.thinkingReason === 'hint') {
        // A hint is for the player's benefit; if they have decided already,
        // abandon it and play. Queuing here left the move to fire much later,
        // as a second move in a row.
        await this.cancelThinking();
      } else {
        // The opponent is thinking. Queue rather than drop: the player has
        // already committed, and the move is played the moment it answers.
        this.premove = move;
        return null;
      }
    }
    if (this.state.isReviewing) {
      // Moving from a reviewed position starts a variation there, which is the
      // whole point of the move tree.
      this.emit('branch', { node: this.state.node });
    }
    if (!this.isPlayerTurn && this.mode === 'engine') return null;

    const spent = performance.now() - this.#moveStartedAt;
    const played = this.state.move(move, {
      timeSpent: Math.round(spent),
      clock: this.clock.isUntimed ? undefined : this.clock.timeLeft(this.state.turn),
    });
    if (!played) {
      this.emit('illegal', { move });
      return null;
    }

    this.#afterMove();
    await this.maybePlayEngineMove();
    return played;
  }

  #afterMove() {
    this.#moveStartedAt = performance.now();
    if (!this.clock.isUntimed && !this.state.isFinished) this.clock.press(this.state.turn);
    if (this.state.isFinished) this.clock.stop();
    this.emit('status', this.status());
  }

  /** Asks the computer for a move, if it is its turn. */
  async maybePlayEngineMove() {
    if (this.mode !== 'engine') return null;
    if (this.state.isFinished || this.state.isReviewing) return null;
    if (this.state.turn === this.playerColor) return null;
    if (!this.opponent) return null;

    // Lozza never returns from a search of a mated or stalemated position.
    if (this.state.chess.isGameOver()) return null;

    // Remember where the search started. The player is free to step back
    // through the game while the computer thinks, and its reply belongs to the
    // position it was computed for — not to whatever they are looking at.
    const searchNode = this.state.node;

    this.thinking = true;
    this.thinkingReason = 'opponent';
    this.emit('thinking', { thinking: true });
    this.emit('status', this.status());

    const controller = new AbortController();
    this.pendingSearch = controller;
    let choice;
    try {
      choice = await this.opponent.chooseMove({
        fen: this.state.fen,
        sanHistory: this.state.tree.currentLine().map((node) => node.move.san),
        signal: controller.signal,
        timeLeft: this.clock.isUntimed ? null : this.clock.timeLeft(this.state.turn),
      });
    } finally {
      this.pendingSearch = null;
      this.thinking = false;
      this.thinkingReason = null;
      this.emit('thinking', { thinking: false });
    }

    if (!choice || choice.source === 'aborted') {
      // Nothing was played, so a queued premove would be a move out of turn.
      this.premove = null;
      this.emit('status', this.status());
      return null;
    }

    // Put the cursor back on the searched position, play there, then restore
    // the player's view if they had moved it.
    const viewing = this.state.node;
    if (viewing !== searchNode) this.state.goTo(searchNode);

    const played = this.state.move(choice.san ?? choice.move, {
      timeSpent: Math.round(choice.elapsedMs),
      clock: this.clock.isUntimed ? undefined : this.clock.timeLeft(this.state.turn),
    });
    if (played && choice.evaluation) {
      // Engine scores are side-to-move relative; store them white-relative.
      const sign = played.color === 'w' ? 1 : -1;
      this.state.node.evaluation = { ...choice.evaluation, value: choice.evaluation.value * sign };
    }
    this.#afterMove();
    if (viewing !== searchNode && this.state.tree.findById(viewing.id)) {
      this.state.goTo(viewing);
    }

    // Let a queued human move through now that the engine has answered.
    if (played && this.premove) {
      const queued = this.premove;
      this.premove = null;
      await this.play(queued);
    }
    return played;
  }

  /** Stops the engine mid-search. Cancellation discards its worker. */
  async cancelThinking() {
    if (!this.thinking) return;
    this.pendingSearch?.abort();
    await this.engine?.cancel().catch(() => {});
    this.thinking = false;
    this.thinkingReason = null;
    // Whatever was queued was queued against a search that never landed.
    this.premove = null;
    this.emit('thinking', { thinking: false });
  }

  // ------------------------------------------------------------ navigation

  goTo(nodeId) {
    const node = this.state.tree.findById(nodeId);
    if (node) this.state.goTo(node);
    this.emit('status', this.status());
    return node;
  }

  back() {
    this.state.back();
    this.emit('status', this.status());
  }

  forward() {
    this.state.forward();
    this.emit('status', this.status());
  }

  toStart() {
    this.state.toStart();
    this.emit('status', this.status());
  }

  toEnd() {
    this.state.toEnd();
    this.emit('status', this.status());
  }

  /**
   * Takes back to the player's previous turn.
   *
   * Against the computer that usually means two plies — undoing only its reply
   * would just hand it another go at the same position — but not always. If the
   * computer has not yet replied, or the game is only one ply old, undoing two
   * would take back a move the player never made.
   */
  async takeback() {
    await this.cancelThinking();
    // A resignation or agreed draw is not a move, so undoing moves cannot lift
    // it. Taking back is a statement that the game is not over after all.
    this.state.adjudication = null;
    this.clock.flagged = null;
    this.state.toEnd();
    if (this.state.ply === 0) {
      this.emit('status', this.status());
      return;
    }

    // One ply always. A second only if it exists and it was the computer's.
    this.state.undo();
    if (this.mode === 'engine' && this.state.ply > 0 && this.state.turn !== this.playerColor) {
      this.state.undo();
    }
    this.emit('status', this.status());
    // Taking back the computer's opening move leaves it on move with nothing
    // to prompt it. Ask again — it may well choose differently.
    await this.maybePlayEngineMove();
  }

  resign() {
    const loser = this.mode === 'engine' ? this.playerColor : this.state.turn;
    this.state.adjudicate('resignation', opposite(loser));
    this.clock.stop();
    return this.state.result();
  }

  agreeDraw() {
    this.state.adjudicate('agreement', null);
    this.clock.stop();
    return this.state.result();
  }

  flip() {
    this.playerColor = opposite(this.playerColor);
    this.settings.playerColor = this.playerColor;
    this.emit('status', this.status());
    return this.playerColor;
  }

  /**
   * Replaces the game with a serialised one — a reload, a PGN import, a game
   * out of the library. Re-wires the state's listeners, which is why this
   * cannot be done by assigning `session.state` from outside.
   */
  loadState(json, { mode = this.mode, playerColor = this.playerColor } = {}) {
    this.state.removeAllListeners();
    this.state = GameState.fromJSON(json);
    this.#wireState();
    this.mode = mode;
    this.playerColor = playerColor;
    this.lastMove = this.state.node.move ?? null;
    this.#moveStartedAt = performance.now();
    this.startClock();
    this.emit('change', { node: this.state.node, reason: 'load' });
    this.emit('status', this.status());
    return this.state;
  }

  /** Replaces the game with one parsed from PGN. */
  loadPgn(text) {
    this.state.removeAllListeners();
    this.state = new GameState();
    this.#wireState();
    this.state.loadPgn(text);
    this.state.toEnd();
    this.emit('change', { node: this.state.node, reason: 'load' });
    this.emit('status', this.status());
    return this.state;
  }

  // --------------------------------------------------------------- reading

  /** A hint: the engine's own choice for the position, at full strength. */
  async hint() {
    if (!this.engine || this.thinking || this.state.isFinished) return null;
    this.thinking = true;
    this.thinkingReason = 'hint';
    this.emit('thinking', { thinking: true, reason: 'hint' });
    try {
      const result = await this.engine.search(this.state.fen, { movetime: 1200 });
      const move = parseUciMove(result.bestmove);
      return move ? { ...move, evaluation: result.info?.score ?? null } : null;
    } catch {
      return null;
    } finally {
      this.thinking = false;
      this.thinkingReason = null;
      this.emit('thinking', { thinking: false });
    }
  }

  status() {
    const result = this.state.result();
    const opening = identifyOpening(this.state.tree.currentLine().map((node) => node.move.san));
    return {
      mode: this.mode,
      turn: this.state.turn,
      playerColor: this.playerColor,
      isPlayerTurn: this.isPlayerTurn,
      thinking: this.thinking,
      reviewing: this.state.isReviewing,
      check: this.state.isCheck,
      result,
      opening,
      material: this.state.material(),
      ply: this.state.ply,
      fen: this.state.fen,
    };
  }

  /** Square the side-to-move's king stands on, for the check highlight. */
  kingSquare(color = this.state.turn) {
    const wanted = `${color}K`;
    for (const [square, code] of Object.entries(this.state.position())) {
      if (code === wanted) return square;
    }
    return null;
  }

  #finish(result) {
    this.clock.stop();
    this.emit('gameover', result);
  }

  toJSON() {
    return {
      mode: this.mode,
      playerColor: this.playerColor,
      settings: this.settings,
      clock: this.clock.toJSON(),
      state: this.state.toJSON(),
    };
  }

  /** Restores a persisted clock. Without this a reload handed back full time. */
  restoreClock(saved) {
    if (!saved || saved.initial === null || saved.initial === undefined) return;
    this.clock.reset({ initial: saved.initial, increment: saved.increment });
    this.clock.delayMode = saved.delayMode ?? this.clock.delayMode;
    this.clock.remaining = {
      w: saved.remaining?.w ?? saved.initial,
      b: saved.remaining?.b ?? saved.initial,
    };
    this.clock.flagged = saved.flagged ?? null;
    this.startClock();
  }

  dispose() {
    this.engine?.dispose();
    this.state.removeAllListeners();
    this.clock.removeAllListeners();
    this.removeAllListeners();
  }
}
