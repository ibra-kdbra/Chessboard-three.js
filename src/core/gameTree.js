/**
 * The move tree.
 *
 * A flat move list is enough to play a game and hopeless for analysing one: the
 * moment you want to ask "what if I had played this instead?" you need branches.
 * Every position in the game is a node; `children[0]` is the mainline
 * continuation and the rest are variations, which is exactly how PGN nests them.
 *
 * This module is deliberately free of chess rules — it stores whatever move
 * objects it is handed. `GameState` owns the rules and drives this.
 */

let nextId = 0;
const freshId = () => `n${(nextId++).toString(36)}`;

/** Resets id allocation. Tests only — ids are never persisted. */
export function _resetIds() {
  nextId = 0;
}

export class GameNode {
  constructor({ move = null, fen, parent = null, ply = 0, origin = null }) {
    this.id = freshId();
    /** @type {GameNode | null} */
    this.parent = parent;
    /** @type {GameNode[]} children[0] is the mainline continuation. */
    this.children = [];
    /** Verbose move object (`{from, to, san, flags, piece, captured, promotion}`) or null at the root. */
    this.move = move;
    /** FEN of the position *after* `move`. */
    this.fen = fen;
    /** Half-moves from the root. */
    this.ply = ply;
    /**
     * Where the game started: `{ turn, moveNumber }` from the root FEN.
     *
     * Ply parity alone is not enough — a game loaded from a position with Black
     * to move on move 12 would otherwise be numbered as if White had opened it.
     */
    this.origin = origin ?? parent?.origin ?? { turn: 'w', moveNumber: 1 };

    // Annotations.
    this.comment = '';
    /** Numeric Annotation Glyphs, e.g. 1 = `!`, 4 = `??`. */
    this.nags = [];
    /** `{ type: 'cp' | 'mate', value: number, depth: number }` from an engine. */
    this.evaluation = null;
    /** Principal variation (array of SAN strings) the engine gave for this position. */
    this.pv = null;
    /** Clock reading after the move, in ms. */
    this.clock = null;
    /** Wall time the mover spent, in ms. */
    this.timeSpent = null;
    /** Set by the review pass: 'blunder' | 'mistake' | 'inaccuracy' | 'good' | 'best' | 'book'. */
    this.quality = null;
  }

  get isRoot() {
    return this.parent === null;
  }

  /** True when this node continues its parent's mainline. */
  get isMainline() {
    let node = this;
    while (node.parent) {
      if (node.parent.children[0] !== node) return false;
      node = node.parent;
    }
    return true;
  }

  /** 1-based move number, as printed in notation. */
  get moveNumber() {
    // Count from the root's own move number, and from whoever was to move
    // there — a game that starts mid-position does not start at 1. w.
    const offset = this.origin.turn === 'w' ? 0 : 1;
    return this.origin.moveNumber + Math.floor((this.ply - 1 + offset) / 2);
  }

  /** Colour that played `move`. */
  get color() {
    const first = this.origin.turn;
    const even = this.ply % 2 === 1;
    return even ? first : first === 'w' ? 'b' : 'w';
  }

  /** Root-first path of nodes ending at this one, root included. */
  path() {
    const out = [];
    for (let node = this; node; node = node.parent) out.unshift(node);
    return out;
  }

  /** Nodes from this one down its own mainline, excluding this one. */
  mainlineBelow() {
    const out = [];
    for (let node = this.children[0]; node; node = node.children[0]) out.push(node);
    return out;
  }
}

export class GameTree {
  /**
   * @param {string} startFen FEN of the initial position.
   * @param {Record<string, string>} [headers] PGN tag pairs.
   */
  constructor(startFen, headers = {}) {
    this.startFen = startFen;
    const [, turn = 'w', , , , fullmove = '1'] = String(startFen).trim().split(/\s+/);
    const origin = {
      turn: turn === 'b' ? 'b' : 'w',
      moveNumber: Number.parseInt(fullmove, 10) || 1,
    };
    this.origin = origin;
    this.root = new GameNode({ fen: startFen, ply: 0, origin });
    this.headers = { ...headers };
    /** @type {GameNode} the node whose position is currently shown. */
    this.current = this.root;
  }

  /**
   * Adds `move` as a continuation of `parent`. If an identical move already
   * exists there we reuse it rather than duplicating the branch, which is what
   * makes transposing back into a known line feel seamless.
   * @returns {GameNode} the node for the position after the move.
   */
  addMove(move, fen, parent = this.current) {
    const existing = parent.children.find((child) => child.move?.san === move.san);
    if (existing) {
      this.current = existing;
      return existing;
    }
    const node = new GameNode({ move, fen, parent, ply: parent.ply + 1, origin: this.origin });
    parent.children.push(node);
    this.current = node;
    return node;
  }

  /** Removes `node` and everything under it. The root cannot be removed. */
  remove(node) {
    if (node.isRoot) throw new Error('cannot remove the root node');
    const siblings = node.parent.children;
    const at = siblings.indexOf(node);
    if (at === -1) return false;
    siblings.splice(at, 1);
    // If we deleted the branch we were standing on, fall back to its parent.
    if (this.current.path().includes(node)) this.current = node.parent;
    return true;
  }

  /** Discards every sibling branch alongside `node`, keeping only its line. */
  removeSiblings(node) {
    if (node.isRoot) return;
    node.parent.children = [node];
  }

  /**
   * Deletes everything after `node` on every branch.
   *
   * If the cursor was standing on something that just became unreachable, it
   * moves to `node`. The guard used to be the wrong way round, which left the
   * cursor on a detached subtree — `size` and `currentLine()` then disagreed.
   */
  truncateAfter(node) {
    const strandedCursor = this.current !== node && this.current.path().includes(node);
    node.children = [];
    if (strandedCursor || !this.current.path().includes(this.root)) this.current = node;
  }

  /**
   * Makes `node` its parent's mainline continuation. Repeating this up the path
   * promotes the whole variation to the game's mainline.
   */
  promote(node, { toMainline = false } = {}) {
    if (node.isRoot) return;
    const siblings = node.parent.children;
    const at = siblings.indexOf(node);
    if (at > 0) {
      siblings.splice(at, 1);
      siblings.unshift(node);
    }
    if (toMainline && node.parent) this.promote(node.parent, { toMainline });
  }

  /** The game's mainline, root excluded. */
  mainline() {
    return this.root.mainlineBelow();
  }

  /** The line actually being viewed, root excluded. */
  currentLine() {
    return this.current.path().slice(1);
  }

  /** Depth-first walk over every node, root first. */
  *walk(from = this.root) {
    yield from;
    for (const child of from.children) yield* this.walk(child);
  }

  findById(id) {
    for (const node of this.walk()) if (node.id === id) return node;
    return null;
  }

  /** Total nodes excluding the root. */
  get size() {
    let count = -1;
    for (const _ of this.walk()) count++;
    return count;
  }

  /** Navigation helpers; each returns the node now current. */
  goTo(node) {
    this.current = node;
    return node;
  }

  back() {
    if (this.current.parent) this.current = this.current.parent;
    return this.current;
  }

  forward() {
    if (this.current.children[0]) this.current = this.current.children[0];
    return this.current;
  }

  toStart() {
    this.current = this.root;
    return this.current;
  }

  /** Runs to the end of the line currently being viewed, not of the mainline. */
  toEnd() {
    while (this.current.children[0]) this.current = this.current.children[0];
    return this.current;
  }

  /**
   * Serialisable snapshot. Node ids are regenerated on load, so nothing outside
   * a session may hold onto them.
   */
  toJSON() {
    const encode = (node) => ({
      m: node.move,
      f: node.fen,
      c: node.comment || undefined,
      n: node.nags.length ? node.nags : undefined,
      e: node.evaluation || undefined,
      pv: node.pv || undefined,
      cl: node.clock ?? undefined,
      ts: node.timeSpent ?? undefined,
      q: node.quality || undefined,
      k: node.children.length ? node.children.map(encode) : undefined,
    });
    return {
      version: 1,
      startFen: this.startFen,
      headers: this.headers,
      children: this.root.children.map(encode),
      currentPath: this.currentLine().map((node) => node.parent.children.indexOf(node)),
    };
  }

  static fromJSON(data) {
    const tree = new GameTree(data.startFen, data.headers ?? {});
    const decode = (raw, parent) => {
      const node = new GameNode({
        move: raw.m,
        fen: raw.f,
        parent,
        ply: parent.ply + 1,
        origin: tree.origin,
      });
      node.comment = raw.c ?? '';
      node.nags = raw.n ?? [];
      node.evaluation = raw.e ?? null;
      node.pv = raw.pv ?? null;
      node.clock = raw.cl ?? null;
      node.timeSpent = raw.ts ?? null;
      node.quality = raw.q ?? null;
      parent.children.push(node);
      for (const child of raw.k ?? []) decode(child, node);
      return node;
    };
    for (const child of data.children ?? []) decode(child, tree.root);

    let cursor = tree.root;
    for (const index of data.currentPath ?? []) {
      if (!cursor.children[index]) break;
      cursor = cursor.children[index];
    }
    tree.current = cursor;
    return tree;
  }
}
