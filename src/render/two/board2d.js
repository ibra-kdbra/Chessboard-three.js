/**
 * The 2D board.
 *
 * Implements the same BoardRenderer contract as the 3D one, so switching
 * between them is a swap rather than a special case. It exists for three
 * reasons: WebGL is not always available, a 3D board is genuinely harder to
 * read at a glance, and on a weak phone this costs almost nothing to draw.
 *
 * Canvas rather than DOM, so it matches the 3D renderer's shape — one element
 * filling its container, sized from the device pixel ratio — and so overlays,
 * arrows and animation all live in one coordinate system.
 */
import { Emitter } from '../../core/emitter.js';
import { calculateAnimations, fenToPosition } from '../../core/positionDiff.js';
import { FILES, RANKS, isLightSquare } from '../../core/constants.js';
import { TIMING, Ticker, easing, movePlan } from '../three/animation.js';
import { getTheme } from '../three/themes.js';

export const PIECE_IMAGE_SETS = Object.freeze({
  wikipedia: { id: 'wikipedia', name: 'Wikipedia', path: 'img/chesspieces/wikipedia' },
  alpha: { id: 'alpha', name: 'Alpha', path: 'img/chesspieces/alpha' },
  uscf: { id: 'uscf', name: 'USCF', path: 'img/chesspieces/uscf' },
});

const PIECE_CODES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];

const imageCache = new Map();

/** Loads a piece set once and shares it between boards. */
export function loadPieceImages(setId, { basePath } = {}) {
  const set = PIECE_IMAGE_SETS[setId] ?? PIECE_IMAGE_SETS.wikipedia;
  const root = basePath ?? set.path;
  if (imageCache.has(root)) return imageCache.get(root);

  const entry = Promise.all(
    PIECE_CODES.map(
      (code) =>
        new Promise((resolve) => {
          const image = new Image();
          image.decoding = 'async';
          // A missing sprite must not stall the board; it draws a letter instead.
          image.onload = () => resolve([code, image]);
          image.onerror = () => resolve([code, null]);
          image.src = `${root}/${code}.png`;
        }),
    ),
  ).then((pairs) => Object.fromEntries(pairs));

  imageCache.set(root, entry);
  return entry;
}

/** Board colours, derived from the shared theme definitions. */
function paletteFor(theme) {
  const hex = (value) => `#${(value >>> 0).toString(16).padStart(6, '0')}`;
  return {
    light: hex(theme.board.light.color ?? 0xe9d4b0),
    dark: hex(theme.board.dark.color ?? 0x6d4a2c),
    frame: hex(theme.board.frame.color ?? 0x4a2f1c),
    inlay: hex(theme.board.inlay ?? 0xd8c49a),
    highlights: theme.highlights,
  };
}

const rgba = (value, alpha) =>
  `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;

export class Board2D extends Emitter {
  /**
   * @param {HTMLElement|string} container
   * @param {{ theme?: string, pieceSet?: string, orientation?: 'white'|'black',
   *           interactive?: boolean, showNotation?: boolean,
   *           reducedMotion?: boolean, assetPath?: string }} [config]
   */
  constructor(container, config = {}) {
    super();
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    if (!this.container) throw new Error('Board2D: container not found');

    this.config = {
      theme: 'tournament',
      pieceSet: 'wikipedia',
      orientation: 'white',
      interactive: true,
      showNotation: true,
      reducedMotion: false,
      ...config,
    };
    this.theme = getTheme(this.config.theme);
    this.palette = paletteFor(this.theme);
    this._orientation = this.config.orientation;
    this.position = {};
    this.images = {};
    this.ready = false;
    this.destroyed = false;

    this.ticker = new Ticker();
    this.ticker.reducedMotion = this.config.reducedMotion;

    /** square -> {x, y} offset in squares, while a piece is mid-move. */
    this.offsets = new Map();
    /** Pieces being animated away, drawn on top of the board until they vanish. */
    this.ghosts = [];
    this.highlights = {};
    this.arrows = [];
    this.selected = null;
    this.hover = null;
    this.drag = null;

    this.#build();
  }

  #frame = null;
  #dirty = true;
  #handlers = [];

  get capabilities() {
    return {
      dimensions: 2,
      cameraModes: false,
      quality: false,
      arrows: true,
      themes: true,
      pieceSets: true,
    };
  }

  #build() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.container.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    const on = (type, handler, options) => {
      this.canvas.addEventListener(type, handler, options);
      this.#handlers.push([type, handler, options]);
    };
    on('pointerdown', (event) => this.#onPointerDown(event));
    on('pointermove', (event) => this.#onPointerMove(event));
    on('pointerup', (event) => this.#onPointerUp(event));
    on('pointerleave', () => this.#setHover(null));
    on('contextmenu', (event) => event.preventDefault());

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }

    loadPieceImages(this.config.pieceSet, { basePath: this.config.assetPath }).then((images) => {
      if (this.destroyed) return;
      this.images = images;
      this.ready = true;
      this.#dirty = true;
      this.emit('ready', this);
    });

    this.resize();
    this.#loop();
  }

  // ------------------------------------------------------------- geometry

  /** Board metrics for the current canvas size. */
  #metrics() {
    const rect = this.container.getBoundingClientRect();
    const size = Math.max(1, Math.min(rect.width, rect.height));
    const border = this.config.showNotation ? Math.round(size * 0.045) : 0;
    const boardSize = size - border * 2;
    return {
      size,
      border,
      square: boardSize / 8,
      originX: (rect.width - size) / 2 + border,
      originY: (rect.height - size) / 2 + border,
      width: rect.width,
      height: rect.height,
    };
  }

  /** Top-left corner of a square, in canvas pixels. */
  #squareOrigin(square, metrics) {
    const file = FILES.indexOf(square[0]);
    const rank = RANKS.indexOf(square[1]);
    const column = this._orientation === 'white' ? file : 7 - file;
    const row = this._orientation === 'white' ? 7 - rank : rank;
    return {
      x: metrics.originX + column * metrics.square,
      y: metrics.originY + row * metrics.square,
    };
  }

  #squareAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const metrics = this.#metrics();
    const column = Math.floor((clientX - rect.left - metrics.originX) / metrics.square);
    const row = Math.floor((clientY - rect.top - metrics.originY) / metrics.square);
    if (column < 0 || column > 7 || row < 0 || row > 7) return null;
    const file = this._orientation === 'white' ? column : 7 - column;
    const rank = this._orientation === 'white' ? 7 - row : row;
    return `${FILES[file]}${RANKS[rank]}`;
  }

  // -------------------------------------------------------------- drawing

  #draw() {
    const ctx = this.ctx;
    const metrics = this.#metrics();
    ctx.clearRect(0, 0, metrics.width, metrics.height);

    if (metrics.border) {
      ctx.fillStyle = this.palette.frame;
      ctx.fillRect(
        metrics.originX - metrics.border,
        metrics.originY - metrics.border,
        metrics.size,
        metrics.size,
      );
    }

    this.#drawSquares(ctx, metrics);
    this.#drawHighlights(ctx, metrics);
    if (this.config.showNotation) this.#drawNotation(ctx, metrics);
    this.#drawPieces(ctx, metrics);
    this.#drawArrows(ctx, metrics);
    if (this.drag) this.#drawDragged(ctx, metrics);
  }

  #drawSquares(ctx, metrics) {
    for (const file of FILES) {
      for (const rank of RANKS) {
        const square = `${file}${rank}`;
        const { x, y } = this.#squareOrigin(square, metrics);
        ctx.fillStyle = isLightSquare(square) ? this.palette.light : this.palette.dark;
        // Overdraw by a hair: fractional square sizes otherwise leave seams.
        ctx.fillRect(x, y, metrics.square + 0.5, metrics.square + 0.5);
      }
    }
  }

  #tint(ctx, metrics, square, color, alpha) {
    if (!square) return;
    const { x, y } = this.#squareOrigin(square, metrics);
    ctx.fillStyle = rgba(color, alpha);
    ctx.fillRect(x, y, metrics.square, metrics.square);
  }

  #drawHighlights(ctx, metrics) {
    const palette = this.palette.highlights;
    const state = this.highlights;

    if (state.lastMove) {
      this.#tint(ctx, metrics, state.lastMove.from, palette.lastMove, 0.35);
      this.#tint(ctx, metrics, state.lastMove.to, palette.lastMove, 0.35);
    }
    if (state.hint) {
      this.#tint(ctx, metrics, state.hint.from, palette.hint, 0.4);
      this.#tint(ctx, metrics, state.hint.to, palette.hint, 0.4);
    }
    if (state.premove) {
      this.#tint(ctx, metrics, state.premove.from, palette.premove, 0.35);
      this.#tint(ctx, metrics, state.premove.to, palette.premove, 0.35);
    }
    if (this.hover) this.#tint(ctx, metrics, this.hover, palette.hover, 0.1);
    if (state.check) this.#drawCheckGlow(ctx, metrics, state.check);

    const selected = this.selected ?? state.selected;
    if (selected) {
      const { x, y } = this.#squareOrigin(selected, metrics);
      ctx.save();
      ctx.strokeStyle = rgba(palette.selected, 0.95);
      ctx.lineWidth = Math.max(2, metrics.square * 0.06);
      ctx.strokeRect(
        x + ctx.lineWidth / 2,
        y + ctx.lineWidth / 2,
        metrics.square - ctx.lineWidth,
        metrics.square - ctx.lineWidth,
      );
      ctx.restore();
    }

    for (const move of state.legal ?? []) {
      const { x, y } = this.#squareOrigin(move.to, metrics);
      const centreX = x + metrics.square / 2;
      const centreY = y + metrics.square / 2;
      ctx.beginPath();
      if (move.capture) {
        // A ring, so the piece being taken stays visible inside it.
        ctx.strokeStyle = rgba(palette.legalCapture, 0.85);
        ctx.lineWidth = metrics.square * 0.07;
        ctx.arc(centreX, centreY, metrics.square * 0.42, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(palette.legal, 0.65);
        ctx.arc(centreX, centreY, metrics.square * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  #drawCheckGlow(ctx, metrics, square) {
    const { x, y } = this.#squareOrigin(square, metrics);
    const centreX = x + metrics.square / 2;
    const centreY = y + metrics.square / 2;
    const gradient = ctx.createRadialGradient(
      centreX,
      centreY,
      0,
      centreX,
      centreY,
      metrics.square * 0.62,
    );
    gradient.addColorStop(0, rgba(this.palette.highlights.check, 0.85));
    gradient.addColorStop(0.7, rgba(this.palette.highlights.check, 0.35));
    gradient.addColorStop(1, rgba(this.palette.highlights.check, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(
      x - metrics.square * 0.1,
      y - metrics.square * 0.1,
      metrics.square * 1.2,
      metrics.square * 1.2,
    );
  }

  #drawNotation(ctx, metrics) {
    ctx.save();
    ctx.fillStyle = this.palette.inlay;
    ctx.font = `600 ${Math.round(metrics.border * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [index, file] of FILES.entries()) {
      const column = this._orientation === 'white' ? index : 7 - index;
      const x = metrics.originX + (column + 0.5) * metrics.square;
      ctx.fillText(file, x, metrics.originY + metrics.square * 8 + metrics.border / 2);
    }
    for (const [index, rank] of RANKS.entries()) {
      const row = this._orientation === 'white' ? 7 - index : index;
      const y = metrics.originY + (row + 0.5) * metrics.square;
      ctx.fillText(rank, metrics.originX - metrics.border / 2, y);
    }
    ctx.restore();
  }

  #drawPiece(ctx, code, x, y, size, alpha = 1) {
    const image = this.images[code];
    ctx.save();
    ctx.globalAlpha = alpha;
    if (image) {
      const inset = size * 0.04;
      ctx.drawImage(image, x + inset, y + inset, size - inset * 2, size - inset * 2);
    } else {
      // The sprite failed to load: a letter is still playable.
      ctx.fillStyle = code[0] === 'w' ? '#f4f1ea' : '#1b1f26';
      ctx.strokeStyle = code[0] === 'w' ? '#1b1f26' : '#f4f1ea';
      ctx.lineWidth = 1.5;
      ctx.font = `700 ${size * 0.62}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(code[1], x + size / 2, y + size / 2);
      ctx.strokeText(code[1], x + size / 2, y + size / 2);
    }
    ctx.restore();
  }

  #drawPieces(ctx, metrics) {
    for (const ghost of this.ghosts) {
      const { x, y } = this.#squareOrigin(ghost.square, metrics);
      this.#drawPiece(ctx, ghost.code, x, y, metrics.square, ghost.alpha);
    }
    for (const [square, code] of Object.entries(this.position)) {
      if (this.drag?.square === square) continue;
      const { x, y } = this.#squareOrigin(square, metrics);
      const offset = this.offsets.get(square);
      this.#drawPiece(
        ctx,
        code,
        x + (offset?.x ?? 0) * metrics.square,
        y + (offset?.y ?? 0) * metrics.square,
        metrics.square,
        offset?.alpha ?? 1,
      );
    }
  }

  #drawDragged(ctx, metrics) {
    const code = this.position[this.drag.square];
    if (!code) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = metrics.square * 0.2;
    this.#drawPiece(
      ctx,
      code,
      this.drag.x - metrics.square / 2,
      this.drag.y - metrics.square / 2,
      metrics.square * 1.08,
    );
    ctx.restore();
  }

  #drawArrows(ctx, metrics) {
    for (const arrow of this.arrows) {
      const from = this.#squareOrigin(arrow.from, metrics);
      const to = this.#squareOrigin(arrow.to, metrics);
      const half = metrics.square / 2;
      const x1 = from.x + half;
      const y1 = from.y + half;
      const x2 = to.x + half;
      const y2 = to.y + half;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = metrics.square * 0.32;
      const width = metrics.square * 0.14;
      // Stop the shaft short so the head is a clean triangle, not a blob.
      const endX = x2 - Math.cos(angle) * head * 0.9;
      const endY = y2 - Math.sin(angle) * head * 0.9;

      ctx.save();
      ctx.globalAlpha = arrow.opacity ?? 0.75;
      ctx.strokeStyle = rgba(arrow.color ?? this.palette.highlights.hint, 1);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(angle - 0.42) * head, y2 - Math.sin(angle - 0.42) * head);
      ctx.lineTo(x2 - Math.cos(angle + 0.42) * head, y2 - Math.sin(angle + 0.42) * head);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // --------------------------------------------------------------- public

  async setPosition(position, { animate = true } = {}) {
    const target = typeof position === 'string' ? fenToPosition(position) : { ...position };
    if (!animate || this.config.reducedMotion || !this.ready) {
      this.position = target;
      this.offsets.clear();
      this.ghosts = [];
      this.#dirty = true;
      return;
    }

    const plan = calculateAnimations(this.position, target);
    const previous = this.position;
    // Commit the new position immediately and animate the *offsets*: that way a
    // second setPosition arriving mid-animation cannot leave a piece stranded.
    this.position = target;
    this.offsets.clear();

    const jobs = [];
    for (const step of plan) {
      if (step.type === 'move') {
        const fromIndex = this.#indexOf(step.source);
        const toIndex = this.#indexOf(step.destination);
        const delta = { x: fromIndex.column - toIndex.column, y: fromIndex.row - toIndex.row };
        const plan2d = movePlan(step.piece, { x: 0, z: 0 }, { x: delta.x * 2, z: delta.y * 2 });
        this.offsets.set(step.destination, { x: delta.x, y: delta.y });
        jobs.push(
          this.ticker.tween({
            duration: plan2d.duration,
            ease: plan2d.ease,
            onUpdate: (t) => {
              this.offsets.set(step.destination, { x: delta.x * (1 - t), y: delta.y * (1 - t) });
              this.#dirty = true;
            },
            onComplete: () => this.offsets.delete(step.destination),
          }),
        );
      } else if (step.type === 'clear') {
        const ghost = { square: step.square, code: previous[step.square] ?? step.piece, alpha: 1 };
        this.ghosts.push(ghost);
        jobs.push(
          this.ticker.tween({
            duration: TIMING.capture,
            ease: easing.easeInQuad,
            onUpdate: (t) => {
              ghost.alpha = 1 - t;
              this.#dirty = true;
            },
            onComplete: () => {
              this.ghosts = this.ghosts.filter((entry) => entry !== ghost);
            },
          }),
        );
      } else if (step.type === 'add') {
        this.offsets.set(step.square, { x: 0, y: 0, alpha: 0 });
        jobs.push(
          this.ticker.tween({
            duration: TIMING.promote,
            ease: easing.easeOutCubic,
            onUpdate: (t) => {
              this.offsets.set(step.square, { x: 0, y: 0, alpha: t });
              this.#dirty = true;
            },
            onComplete: () => this.offsets.delete(step.square),
          }),
        );
      }
    }
    this.#dirty = true;
    await Promise.all(jobs);
    this.emit('positionchange', target);
  }

  #indexOf(square) {
    const file = FILES.indexOf(square[0]);
    const rank = RANKS.indexOf(square[1]);
    return this._orientation === 'white'
      ? { column: file, row: 7 - rank }
      : { column: 7 - file, row: rank };
  }

  getPosition() {
    return { ...this.position };
  }

  orientation(value) {
    if (value === undefined) return this._orientation;
    const next = value === 'flip' ? (this._orientation === 'white' ? 'black' : 'white') : value;
    this._orientation = next;
    this.#dirty = true;
    return next;
  }

  setHighlights(state) {
    this.highlights = state ?? {};
    this.selected = state?.selected ?? this.selected;
    this.#dirty = true;
  }

  setArrows(arrows) {
    this.arrows = arrows ?? [];
    this.#dirty = true;
  }

  setTheme(themeOrId) {
    this.theme = typeof themeOrId === 'string' ? getTheme(themeOrId) : themeOrId;
    this.palette = paletteFor(this.theme);
    this.#dirty = true;
  }

  async setPieceSet(setId) {
    const images = await loadPieceImages(setId, { basePath: this.config.assetPath });
    if (this.destroyed) return;
    this.config.pieceSet = setId;
    this.images = images;
    this.#dirty = true;
  }

  setInteractive(enabled) {
    this.config.interactive = enabled;
    if (!enabled) {
      this.drag = null;
      this.selected = null;
      this.#dirty = true;
    }
  }

  setReducedMotion(enabled) {
    this.config.reducedMotion = enabled;
    this.ticker.reducedMotion = enabled;
  }

  clearSelection() {
    this.selected = null;
    this.#dirty = true;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio ?? 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.imageSmoothingQuality = 'high';
    this.#dirty = true;
  }

  destroy() {
    this.destroyed = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.resizeObserver?.disconnect();
    this.ticker.cancelAll();
    for (const [type, handler, options] of this.#handlers) {
      this.canvas.removeEventListener(type, handler, options);
    }
    this.#handlers = [];
    this.canvas.remove();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- input

  #setHover(square) {
    if (square === this.hover) return;
    this.hover = square;
    this.#dirty = true;
    this.emit('hover', square);
  }

  #onPointerDown(event) {
    if (!this.config.interactive) return;
    const square = this.#squareAt(event.clientX, event.clientY);
    if (event.button === 2) {
      this.rightPress = square;
      return;
    }
    if (event.button !== 0 || !square) return;

    this.press = { square, x: event.clientX, y: event.clientY, dragging: false };
    if (this.position[square]) this.canvas.setPointerCapture?.(event.pointerId);
  }

  #onPointerMove(event) {
    if (!this.config.interactive) return;
    const square = this.#squareAt(event.clientX, event.clientY);
    this.#setHover(square);
    if (!this.press) return;

    if (!this.press.dragging) {
      const travelled = Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y);
      if (travelled < 6 || !this.position[this.press.square]) return;
      this.press.dragging = true;
      this.selected = this.press.square;
      this.emit('select', this.press.square);
    }
    const rect = this.canvas.getBoundingClientRect();
    this.drag = {
      square: this.press.square,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    this.#dirty = true;
  }

  #onPointerUp(event) {
    if (!this.config.interactive) return;
    const square = this.#squareAt(event.clientX, event.clientY);
    this.canvas.releasePointerCapture?.(event.pointerId);

    if (event.button === 2) {
      const from = this.rightPress;
      this.rightPress = null;
      if (from && square && from !== square) this.emit('arrow', { from, to: square });
      return;
    }
    const press = this.press;
    this.press = null;
    const wasDragging = Boolean(this.drag);
    this.drag = null;
    this.#dirty = true;
    if (!press) return;

    if (wasDragging) {
      if (square && square !== press.square) this.emit('move', { from: press.square, to: square });
      else this.selected = null;
      return;
    }

    // A click: select, move, or deselect.
    if (this.selected && square && this.selected !== square) {
      const from = this.selected;
      this.selected = null;
      this.emit('move', { from, to: square });
      return;
    }
    if (square && this.position[square] && this.selected !== square) {
      this.selected = square;
      this.emit('select', square);
      return;
    }
    this.selected = null;
    this.emit('select', null);
  }

  // ----------------------------------------------------------- render loop

  #loop() {
    const frame = (now) => {
      if (this.destroyed) return;
      this.#frame = requestAnimationFrame(frame);
      const animating = this.ticker.update(now);
      if (this.#dirty || animating) {
        this.#draw();
        this.#dirty = false;
      }
    };
    this.#frame = requestAnimationFrame(frame);
  }
}
