/**
 * The authoritative model of a game in progress.
 *
 * Owns the rules (via chess.js) and the move tree, and is the only thing that
 * mutates either. Everything else — renderers, panels, the engine driver —
 * observes it and reacts. DOM-free and three.js-free on purpose: this is the
 * layer that gets unit-tested in node.
 */
import { Chess } from 'chess.js';
import { GameTree } from './gameTree.js';
import { writePgn, parsePgn } from './pgn.js';
import { Emitter } from './emitter.js';
import {
  KING,
  PAWN,
  PIECE_TYPES,
  PIECE_VALUES,
  START_FEN,
  WHITE,
  BLACK,
  opposite,
} from './constants.js';

/** chess.js Move instances carry methods; the tree stores plain snapshots. */
function plainMove(move) {
  return {
    color: move.color,
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured,
    promotion: move.promotion,
    flags: move.flags,
    san: move.san,
    lan: move.lan,
    before: move.before,
    after: move.after,
  };
}

/**
 * Events: `change` (position moved), `move` (a move was played),
 * `illegal`, `gameover`, `treechange` (annotations/branches edited).
 */
export class GameState extends Emitter {
  constructor({ fen = START_FEN, headers = {} } = {}) {
    super();
    this.startFen = fen;
    this.chess = new Chess(fen);
    this.tree = new GameTree(fen, headers);
    /** Set when a player resigns or a draw is agreed — chess.js cannot know about it. */
    this.adjudication = null;
    /**
     * The Result tag of an imported game, kept only so export round-trips.
     * Deliberately NOT an adjudication: a game someone imported to look at is
     * not a game *they* have finished, and treating it as one froze the tree —
     * no move could be played anywhere in it.
     */
    this.importedResult = null;
  }

  // ---------------------------------------------------------------- position

  get fen() {
    return this.chess.fen();
  }

  get turn() {
    return this.chess.turn();
  }

  get node() {
    return this.tree.current;
  }

  get ply() {
    return this.tree.current.ply;
  }

  /** 8x8 array of `{square, type, color} | null`, rank 8 first — chess.js order. */
  board() {
    return this.chess.board();
  }

  /** `{ [square]: 'wP' | 'bK' | ... }`, the shape renderers consume. */
  position() {
    const out = {};
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell)
          out[cell.square] =
            cell.color === WHITE ? `w${cell.type.toUpperCase()}` : `b${cell.type.toUpperCase()}`;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------- moves

  /** Verbose legal moves, optionally restricted to one origin square. */
  legalMoves(square) {
    return square
      ? this.chess.moves({ square, verbose: true })
      : this.chess.moves({ verbose: true });
  }

  /** Destination squares reachable from `square`. */
  destinations(square) {
    return this.legalMoves(square).map((move) => move.to);
  }

  /** True when a move from `from` to `to` would require choosing a promotion piece. */
  needsPromotion(from, to) {
    return this.legalMoves(from).some((move) => move.to === to && move.promotion);
  }

  /**
   * Plays a move and records it in the tree.
   * @param {string | {from: string, to: string, promotion?: string}} move SAN or coordinates.
   * @param {{ timeSpent?: number, clock?: number }} [meta]
   * @returns {object | null} the plain move object, or null if the move is illegal.
   */
  move(move, meta = {}) {
    if (this.isFinished) return null;
    let played;
    try {
      played = this.chess.move(move);
    } catch {
      played = null;
    }
    if (!played) {
      this.emit('illegal', { move });
      return null;
    }
    const plain = plainMove(played);
    const node = this.tree.addMove(plain, played.after, this.tree.current);
    if (meta.timeSpent !== undefined) node.timeSpent = meta.timeSpent;
    if (meta.clock !== undefined) node.clock = meta.clock;

    this.emit('move', { move: plain, node });
    this.emit('change', { node, reason: 'move' });
    if (this.isFinished) this.emit('gameover', this.result());
    return plain;
  }

  /**
   * Takes back the last move of the line being viewed and deletes it from the
   * tree. Navigating back without deleting is `back()`.
   */
  undo() {
    const node = this.tree.current;
    if (node.isRoot) return null;
    const move = node.move;
    this.tree.remove(node);
    this.syncToNode();
    this.emit('treechange', { reason: 'undo' });
    this.emit('change', { node: this.tree.current, reason: 'undo' });
    return move;
  }

  // -------------------------------------------------------------- navigation

  /**
   * Replays the tree path into chess.js so the rules engine matches the view.
   *
   * If a stored move no longer replays — an edited save, a schema change — the
   * cursor stops at the last position that did, and the unreachable tail is
   * cut. Leaving the rules engine and the tree disagreeing is worse than losing
   * the end of a corrupt game.
   */
  syncToNode(node = this.tree.current) {
    const chess = new Chess(this.tree.startFen);
    let reached = this.tree.root;
    for (const step of node.path().slice(1)) {
      try {
        if (!chess.move(step.move.san)) break;
      } catch {
        break;
      }
      reached = step;
    }
    this.chess = chess;
    this.tree.current = reached;
    if (reached !== node) {
      this.tree.truncateAfter(reached);
      this.emit('treechange', { reason: 'repair' });
    }
    return reached;
  }

  goTo(node) {
    this.syncToNode(node);
    this.emit('change', { node, reason: 'navigate' });
    return node;
  }

  back() {
    return this.tree.current.isRoot ? this.tree.current : this.goTo(this.tree.current.parent);
  }

  forward() {
    const next = this.tree.current.children[0];
    return next ? this.goTo(next) : this.tree.current;
  }

  toStart() {
    return this.goTo(this.tree.root);
  }

  toEnd() {
    let node = this.tree.current;
    while (node.children[0]) node = node.children[0];
    return this.goTo(node);
  }

  /** True when the viewer is behind the end of the line — i.e. reviewing. */
  get isReviewing() {
    return this.tree.current.children.length > 0;
  }

  // ------------------------------------------------------------------ status

  get isCheck() {
    return this.chess.isCheck();
  }

  get isCheckmate() {
    return this.chess.isCheckmate();
  }

  /** True only at the live end of the game — reviewing an earlier node is not "over". */
  get isFinished() {
    return this.adjudication !== null || (!this.isReviewing && this.chess.isGameOver());
  }

  /** Ends the game by agreement or resignation, which the rules engine can't model. */
  adjudicate(kind, winner = null) {
    this.adjudication = { kind, winner };
    this.emit('gameover', this.result());
    return this.result();
  }

  /**
   * @returns {{over: boolean, winner: 'w'|'b'|null, reason: string, scoreString: string}}
   */
  result() {
    if (this.adjudication) {
      const { kind, winner } = this.adjudication;
      return {
        over: true,
        winner,
        reason: kind,
        scoreString: winner === WHITE ? '1-0' : winner === BLACK ? '0-1' : '1/2-1/2',
      };
    }
    if (!this.chess.isGameOver()) {
      return { over: false, winner: null, reason: 'in-progress', scoreString: '*' };
    }
    if (this.chess.isCheckmate()) {
      const winner = opposite(this.chess.turn());
      return {
        over: true,
        winner,
        reason: 'checkmate',
        scoreString: winner === WHITE ? '1-0' : '0-1',
      };
    }
    const reason = this.chess.isStalemate()
      ? 'stalemate'
      : this.chess.isInsufficientMaterial()
        ? 'insufficient-material'
        : this.chess.isThreefoldRepetition()
          ? 'threefold-repetition'
          : this.chess.isDrawByFiftyMoves()
            ? 'fifty-move-rule'
            : 'draw';
    return { over: true, winner: null, reason, scoreString: '1/2-1/2' };
  }

  // ---------------------------------------------------------------- material

  /**
   * What each side has captured, and by how much one is ahead.
   * Derived from the position rather than the move list so it stays right after
   * navigation, promotions and takebacks.
   * @returns {{w: string[], b: string[], balance: number}} `balance` favours white when positive.
   */
  material() {
    const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const live = { w: {}, b: {} };
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell) live[cell.color][cell.type] = (live[cell.color][cell.type] ?? 0) + 1;
      }
    }
    const captured = { w: [], b: [] };
    let balance = 0;
    for (const color of [WHITE, BLACK]) {
      // Every promotion consumes a pawn, so a side that promoted is short a
      // pawn without anyone having taken it. Discount those, or the tray shows
      // a capture that never happened.
      const promotions = PIECE_TYPES.filter((type) => type !== PAWN && type !== KING).reduce(
        (total, type) => total + Math.max(0, (live[color][type] ?? 0) - START_COUNTS[type]),
        0,
      );
      for (const type of PIECE_TYPES) {
        let missing = START_COUNTS[type] - (live[color][type] ?? 0);
        if (type === PAWN) missing -= promotions;
        for (let i = 0; i < Math.max(0, missing); i++) captured[opposite(color)].push(type);
        balance += (color === WHITE ? 1 : -1) * (live[color][type] ?? 0) * PIECE_VALUES[type];
      }
    }
    const byValue = (a, b) => PIECE_VALUES[b] - PIECE_VALUES[a];
    return { w: captured.w.sort(byValue), b: captured.b.sort(byValue), balance };
  }

  // ------------------------------------------------------------ serialisation

  /**
   * Full PGN, variations and annotations included.
   *
   * The result is read from the END of the mainline, not from wherever the
   * cursor happens to be — exporting a finished game while looking back at an
   * earlier move used to write `*`.
   */
  pgn(options = {}) {
    return writePgn(this.tree, { result: this.finalResult().scoreString, ...options });
  }

  /**
   * The game's result, judged at the end of the mainline rather than at the
   * cursor. `result()` answers "what is the state of the position I am looking
   * at"; this answers "how did the game finish".
   */
  finalResult() {
    if (this.adjudication) return this.result();
    const last = this.tree.mainline().at(-1);
    if (last) {
      const scratch = new Chess(last.fen);
      if (scratch.isCheckmate()) {
        const winner = opposite(scratch.turn());
        return {
          over: true,
          winner,
          reason: 'checkmate',
          scoreString: winner === WHITE ? '1-0' : '0-1',
        };
      }
      if (scratch.isGameOver()) {
        return { over: true, winner: null, reason: 'draw', scoreString: '1/2-1/2' };
      }
    }
    if (this.importedResult) {
      return {
        over: true,
        winner:
          this.importedResult === '1-0' ? WHITE : this.importedResult === '0-1' ? BLACK : null,
        reason: 'recorded',
        scoreString: this.importedResult,
      };
    }
    return { over: false, winner: null, reason: 'in-progress', scoreString: '*' };
  }

  /**
   * Replaces the game with one parsed from PGN.
   * @throws {Error} if the movetext contains an illegal move.
   */
  loadPgn(text) {
    const { tree, result } = parsePgn(text);
    this.tree = tree;
    this.startFen = tree.startFen;
    this.adjudication = null;
    // Recorded, not adjudicated: an imported result describes what happened to
    // someone else's game, and must not stop this one from being played on.
    this.importedResult = result === '*' ? null : result;
    this.syncToNode(tree.root);
    this.emit('treechange', { reason: 'load' });
    this.emit('change', { node: this.tree.current, reason: 'load' });
    return this;
  }

  toJSON() {
    return {
      version: 1,
      startFen: this.startFen,
      adjudication: this.adjudication,
      importedResult: this.importedResult,
      tree: this.tree.toJSON(),
    };
  }

  static fromJSON(data) {
    const state = new GameState({ fen: data.startFen });
    state.tree = GameTree.fromJSON(data.tree);
    state.adjudication = data.adjudication ?? null;
    state.importedResult = data.importedResult ?? null;
    state.syncToNode(state.tree.current);
    return state;
  }
}
