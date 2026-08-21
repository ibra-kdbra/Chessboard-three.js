/**
 * The 3D board.
 *
 * Composes scene, board, pieces, highlights and input into something that
 * implements BoardRenderer. Positions go in, animations come out; the renderer
 * knows nothing about rules, engines or whose turn it is.
 *
 * The render loop is dirty-driven — it draws when something moved, the camera
 * moved, or an overlay is mid-pulse, and otherwise idles. That matters on a
 * laptop: an idle chess board should not be burning a core.
 */
import { Group, MathUtils, Spherical, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Emitter } from '../../core/emitter.js';
import { calculateAnimations, fenToPosition } from '../../core/positionDiff.js';
import {
  CAMERA_DISTANCE,
  CAMERA_POLAR_ANGLE,
  CAMERA_TARGET,
  FrameBudget,
  QUALITY_ORDER,
  createScene,
  detectQuality,
  fitCameraToBoard,
} from './scene.js';
import { buildBoard, squareToWorld } from './boardGeometry.js';
import { HighlightLayer } from './highlights.js';
import { BoardInteraction } from './interaction.js';
import { PieceFactory, loadPieceSet } from './pieces.js';
import { TIMING, Ticker, easing, movePath, movePlan } from './animation.js';
import { DEFAULT_THEME, getTheme } from './themes.js';

/** Where the camera sits for each side, before the user orbits it. */
function cameraHome(orientation) {
  const z = CAMERA_DISTANCE * Math.sin(CAMERA_POLAR_ANGLE);
  const y = CAMERA_DISTANCE * Math.cos(CAMERA_POLAR_ANGLE);
  return new Vector3(0, y, orientation === 'black' ? -z : z);
}

/**
 * `zoom` scales the fitted distance rather than setting an absolute one, so
 * every mode stays framed at any aspect ratio.
 */
export const CAMERA_MODES = Object.freeze({
  orbit: { id: 'orbit', name: 'Orbit', polar: CAMERA_POLAR_ANGLE, zoom: 1 },
  top: { id: 'top', name: 'Top down', polar: 0.04, zoom: 0.94 },
  low: { id: 'low', name: "Player's eye", polar: Math.PI / 2.5, zoom: 1.06 },
  cinematic: { id: 'cinematic', name: 'Cinematic', polar: Math.PI / 3.4, zoom: 0.98, drift: true },
});

export class Board3D extends Emitter {
  /**
   * @param {HTMLElement} container
   * @param {{ theme?: string, pieceSet?: string, orientation?: 'white'|'black',
   *           quality?: string, interactive?: boolean, showNotation?: boolean,
   *           cameraControls?: boolean, reducedMotion?: boolean,
   *           assetPath?: string }} [config]
   */
  constructor(container, config = {}) {
    super();
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    if (!this.container) throw new Error('Board3D: container not found');

    this.config = {
      theme: DEFAULT_THEME,
      pieceSet: 'classic',
      orientation: 'white',
      quality: config.quality ?? detectQuality(),
      interactive: true,
      showNotation: true,
      cameraControls: true,
      reducedMotion: false,
      assetPath: 'assets/models',
      ...config,
    };

    this.theme = getTheme(this.config.theme);
    this._orientation = this.config.orientation;
    this.position = {};
    /** square → piece Group */
    this.pieces = new Map();
    this.ready = false;
    this.destroyed = false;
    this.cameraMode = 'orbit';

    this.ticker = new Ticker();
    this.ticker.reducedMotion = this.config.reducedMotion;

    this.#build();
  }

  #dirty = true;
  #startedAt = 0;
  #frameHandle = null;
  #dragging = null;

  get capabilities() {
    return {
      dimensions: 3,
      cameraModes: true,
      quality: true,
      arrows: true,
      themes: true,
      pieceSets: true,
    };
  }

  #build() {
    this.view = createScene(this.container, this.theme, { quality: this.config.quality });
    this.board = buildBoard(this.theme, {
      quality: this.config.quality,
      showNotation: this.config.showNotation,
    });
    this.view.scene.add(this.board.group);

    this.highlights = new HighlightLayer(this.theme, { orientation: this._orientation });
    this.view.scene.add(this.highlights.group);

    this.pieceGroup = new Group();
    this.pieceGroup.name = 'pieces';
    this.view.scene.add(this.pieceGroup);

    this.view.camera.position.copy(cameraHome(this._orientation));
    fitCameraToBoard(this.view.camera, CAMERA_TARGET);

    if (this.config.cameraControls) {
      this.controls = new OrbitControls(this.view.camera, this.view.renderer.domElement);
      this.controls.target.copy(CAMERA_TARGET);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.enablePan = false;
      this.controls.rotateSpeed = 0.55;
      this.controls.zoomSpeed = 0.8;
      this.controls.minDistance = 11;
      this.controls.maxDistance = 34;
      // Keep the camera above the board; below it there is nothing to see.
      this.controls.minPolarAngle = 0.02;
      this.controls.maxPolarAngle = Math.PI / 2.15;
      this.controls.update();
    }

    this.interaction = new BoardInteraction({
      domElement: this.view.renderer.domElement,
      camera: this.view.camera,
      getOrientation: () => this._orientation,
      pieceAt: (square) => this.pieces.get(square) ?? null,
      canPickUp: (square) => this.config.interactive && this.pieces.has(square),
      onHover: (square) => {
        this.#hover = square;
        this.#refreshHighlights();
        this.emit('hover', square);
      },
      onSelect: (square) => {
        this.#selected = square;
        this.#refreshHighlights();
        this.emit('select', square);
      },
      onDragStart: (square) => this.#beginDrag(square),
      onDragMove: (point, square) => this.#updateDrag(point, square),
      onDrop: (from, to) => this.#endDrag(from, to),
      onRightDrag: (from, to) => this.emit('arrow', { from, to }),
    });

    this.frameBudget = new FrameBudget({
      onDowngrade: () => this.#downgradeQuality(),
    });

    this.#observeResize();
    this.#loadPieces().then(() => {
      this.ready = true;
      this.emit('ready', this);
    });
    this.#startLoop();
  }

  #hover = null;
  #selected = null;
  #highlightState = {};

  async #loadPieces() {
    const assets = await loadPieceSet(this.config.pieceSet, { basePath: this.config.assetPath });
    if (this.destroyed) return;
    this.assets = assets;
    this.factory = new PieceFactory(assets, this.theme, { quality: this.config.quality });
    // Anything set before the geometry arrived is drawn now.
    const pending = this.position;
    this.position = {};
    this.#drawInstant(pending);
  }

  // ------------------------------------------------------------------ pieces

  #drawInstant(position) {
    for (const group of this.pieces.values()) {
      this.factory.dispose(group);
      this.pieceGroup.remove(group);
    }
    this.pieces.clear();
    for (const [square, code] of Object.entries(position)) {
      const group = this.factory.create(code);
      this.factory.place(group, square, this._orientation);
      this.pieceGroup.add(group);
      this.pieces.set(square, group);
    }
    this.position = { ...position };
    this.#dirty = true;
  }

  #movePiece(from, to, { duration, arc, ease, delay = 0 }) {
    const group = this.pieces.get(from);
    if (!group) return Promise.resolve();
    this.pieces.delete(from);
    // Claim the destination now so a second animation cannot target it too.
    this.pieces.set(to, group);
    group.userData.square = to;

    const start = squareToWorld(from, this._orientation);
    const end = squareToWorld(to, this._orientation);
    return this.ticker.tween({
      duration,
      delay,
      ease,
      onUpdate: (t) => {
        const point = movePath(start, end, t, { arc });
        group.position.set(point.x, point.y, point.z);
        const shadow = group.userData.contactShadow;
        // The contact shadow shrinks and fades as the piece lifts.
        if (shadow) {
          const lift = point.y / Math.max(arc, 0.001);
          shadow.scale.setScalar(1 + lift * 0.5);
          shadow.material.opacity = 0.6 * (1 - lift * 0.55);
        }
        this.#dirty = true;
      },
      onComplete: () => {
        group.position.set(end.x, 0, end.z);
        const shadow = group.userData.contactShadow;
        if (shadow) {
          shadow.scale.setScalar(1);
          shadow.material.opacity = 0.6;
        }
      },
    });
  }

  #removePiece(square, { animate = true, delay = 0 } = {}) {
    const group = this.pieces.get(square);
    if (!group) return Promise.resolve();
    this.pieces.delete(square);

    const finish = () => {
      this.factory.dispose(group);
      this.pieceGroup.remove(group);
      this.#dirty = true;
    };
    if (!animate) {
      finish();
      return Promise.resolve();
    }

    const mesh = group.userData.mesh;
    mesh.material.transparent = true;
    return this.ticker.tween({
      duration: TIMING.capture,
      delay,
      ease: easing.easeInQuad,
      onUpdate: (t) => {
        // Sink and dissolve, rather than vanish: it reads as being taken.
        mesh.material.opacity = 1 - t;
        group.position.y = -1.4 * t;
        group.scale.setScalar(1 - 0.25 * t);
        const shadow = group.userData.contactShadow;
        if (shadow) shadow.material.opacity = 0.6 * (1 - t);
        this.#dirty = true;
      },
      onComplete: finish,
    });
  }

  #addPiece(square, code, { animate = true, delay = 0 } = {}) {
    const group = this.factory.create(code);
    this.factory.place(group, square, this._orientation);
    this.pieceGroup.add(group);
    this.pieces.set(square, group);

    if (!animate) {
      this.#dirty = true;
      return Promise.resolve();
    }
    const mesh = group.userData.mesh;
    mesh.material.transparent = true;
    mesh.material.opacity = 0;
    group.scale.setScalar(0.4);
    return this.ticker.tween({
      duration: TIMING.promote,
      delay,
      ease: easing.easeOutBackSoft,
      onUpdate: (t) => {
        mesh.material.opacity = Math.min(1, t * 1.6);
        group.scale.setScalar(0.4 + 0.6 * t);
        this.#dirty = true;
      },
      onComplete: () => {
        mesh.material.opacity = 1;
        mesh.material.transparent = false;
        group.scale.setScalar(1);
      },
    });
  }

  // ------------------------------------------------------------- public API

  /**
   * Moves the board to a position. Animations are derived from the difference,
   * so this handles a single move, a takeback and a jump to move 30 alike.
   */
  async setPosition(position, { animate = true } = {}) {
    const target = typeof position === 'string' ? fenToPosition(position) : { ...position };
    if (!this.factory) {
      // Geometry still loading; remember it and draw once it lands.
      this.position = target;
      return;
    }
    if (!animate || this.config.reducedMotion) {
      this.#drawInstant(target);
      return;
    }

    const plan = calculateAnimations(this.position, target);
    const jobs = [];
    // Captures start slightly late so the arriving piece is visibly the cause.
    const clearDelay = plan.some((step) => step.type === 'move') ? TIMING.capture * 0.35 : 0;

    for (const step of plan) {
      if (step.type === 'move') {
        const from = squareToWorld(step.source, this._orientation);
        const to = squareToWorld(step.destination, this._orientation);
        jobs.push(this.#movePiece(step.source, step.destination, movePlan(step.piece, from, to)));
      }
    }
    for (const step of plan) {
      if (step.type === 'clear') jobs.push(this.#removePiece(step.square, { delay: clearDelay }));
      if (step.type === 'add') jobs.push(this.#addPiece(step.square, step.piece, { delay: clearDelay }));
    }

    this.position = target;
    await Promise.all(jobs);
    // The plan is a heuristic; reconcile so a surprising diff cannot desync us.
    this.#reconcile(target);
    this.emit('positionchange', target);
  }

  /** Rebuilds any square whose mesh no longer matches the position of record. */
  #reconcile(target) {
    for (const [square, group] of [...this.pieces]) {
      if (target[square] !== group.userData.pieceCode) {
        this.factory.dispose(group);
        this.pieceGroup.remove(group);
        this.pieces.delete(square);
      }
    }
    for (const [square, code] of Object.entries(target)) {
      if (!this.pieces.has(square)) {
        const group = this.factory.create(code);
        this.factory.place(group, square, this._orientation);
        this.pieceGroup.add(group);
        this.pieces.set(square, group);
      }
    }
    this.#dirty = true;
  }

  getPosition() {
    return { ...this.position };
  }

  /** Reads or sets orientation; `'flip'` toggles. Swivels rather than cuts. */
  orientation(value) {
    if (value === undefined) return this._orientation;
    const next = value === 'flip' ? (this._orientation === 'white' ? 'black' : 'white') : value;
    if (next === this._orientation) return this._orientation;
    this._orientation = next;
    this.highlights.setOrientation(next);

    // The board itself never rotates — pieces are re-placed and the camera
    // swings round. Keeping the world fixed means overlays and arrows need no
    // special cases.
    for (const [square, group] of this.pieces) {
      const { x, z } = squareToWorld(square, next);
      group.position.set(x, group.position.y, z);
    }
    this.#refreshHighlights();
    this.#swivelCamera(next);
    return next;
  }

  /**
   * Rotates the camera to the other side, always by the shorter arc — the
   * original's wrap handling for this is one of the few bits worth keeping.
   */
  #swivelCamera(orientation) {
    const target = cameraHome(orientation);
    const from = new Spherical().setFromVector3(
      this.view.camera.position.clone().sub(CAMERA_TARGET),
    );
    const to = new Spherical().setFromVector3(target.clone().sub(CAMERA_TARGET));
    // Keep the radius and elevation the user chose; only the azimuth flips.
    to.radius = from.radius;
    to.phi = from.phi;
    let delta = to.theta - from.theta;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    if (this.controls) this.controls.enabled = false;
    this.ticker.tween({
      duration: TIMING.cameraFlip,
      ease: easing.easeInOutCubic,
      onUpdate: (t) => {
        const spherical = new Spherical(from.radius, from.phi, from.theta + delta * t);
        this.view.camera.position.setFromSpherical(spherical).add(CAMERA_TARGET);
        this.view.camera.lookAt(CAMERA_TARGET);
        this.#dirty = true;
      },
      onComplete: () => {
        if (this.controls) {
          this.controls.enabled = true;
          this.controls.update();
        }
      },
    });
  }

  setHighlights(state) {
    this.#highlightState = state ?? {};
    this.#refreshHighlights();
  }

  #refreshHighlights() {
    this.highlights.update({
      ...this.#highlightState,
      hover: this.#hover,
      selected: this.#selected ?? this.#highlightState.selected ?? null,
    });
    this.#dirty = true;
  }

  setArrows(arrows) {
    this.highlights.setArrows(arrows);
    this.#dirty = true;
  }

  setTheme(themeOrId) {
    const theme = typeof themeOrId === 'string' ? getTheme(themeOrId) : themeOrId;
    this.theme = theme;
    this.view.applyTheme(theme);
    this.highlights.applyTheme(theme);

    // The board's materials are baked into merged geometry, so it is rebuilt.
    this.view.scene.remove(this.board.group);
    this.board.dispose();
    this.board = buildBoard(theme, {
      quality: this.config.quality,
      showNotation: this.config.showNotation,
    });
    this.view.scene.add(this.board.group);

    this.factory?.applyTheme(theme, this.pieces.values());
    this.#dirty = true;
  }

  async setPieceSet(set) {
    if (set === this.config.pieceSet) return;
    const assets = await loadPieceSet(set, { basePath: this.config.assetPath });
    if (this.destroyed) return;
    this.config.pieceSet = set;
    this.assets = assets;
    this.factory?.disposeShared();
    this.factory = new PieceFactory(assets, this.theme, { quality: this.config.quality });
    this.#drawInstant(this.position);
  }

  setCameraMode(mode) {
    const preset = CAMERA_MODES[mode] ?? CAMERA_MODES.orbit;
    this.cameraMode = preset.id;

    const from = new Spherical().setFromVector3(
      this.view.camera.position.clone().sub(CAMERA_TARGET),
    );
    // Work out the framed distance at the destination angle first, so the
    // tween lands on a shot that actually fits rather than one that crops.
    const probe = this.view.camera.clone();
    probe.position
      .setFromSpherical(new Spherical(from.radius, preset.polar, from.theta))
      .add(CAMERA_TARGET);
    const fitted = fitCameraToBoard(probe, CAMERA_TARGET) * preset.zoom;

    this.ticker.tween({
      duration: 700,
      ease: easing.easeInOutCubic,
      onUpdate: (t) => {
        const spherical = new Spherical(
          MathUtils.lerp(from.radius, fitted, t),
          MathUtils.lerp(from.phi, preset.polar, t),
          from.theta,
        );
        this.view.camera.position.setFromSpherical(spherical).add(CAMERA_TARGET);
        this.view.camera.lookAt(CAMERA_TARGET);
        this.#dirty = true;
      },
      onComplete: () => this.controls?.update(),
    });
    return preset;
  }

  setInteractive(enabled) {
    this.config.interactive = enabled;
    this.interaction.setEnabled(enabled);
  }

  setReducedMotion(enabled) {
    this.config.reducedMotion = enabled;
    this.ticker.reducedMotion = enabled;
  }

  /** Clears the selection without emitting a user-initiated select. */
  clearSelection() {
    this.#selected = null;
    this.interaction.clearSelection();
    this.#refreshHighlights();
  }

  resize() {
    this.view.resize();
    this.#dirty = true;
  }

  destroy() {
    this.destroyed = true;
    if (this.#frameHandle !== null) cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = null;
    this.resizeObserver?.disconnect();
    this.ticker.cancelAll();
    this.interaction.dispose();
    this.controls?.dispose();
    for (const group of this.pieces.values()) this.factory?.dispose(group);
    this.pieces.clear();
    this.factory?.disposeShared();
    this.highlights.dispose();
    this.board.dispose();
    this.view.dispose();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------ drag

  #beginDrag(square) {
    const group = this.pieces.get(square);
    if (!group) return;
    this.#dragging = { square, group, origin: group.position.clone() };
    if (this.controls) this.controls.enabled = false;
    this.#selected = square;
    this.#refreshHighlights();
    this.emit('select', square);
  }

  #updateDrag(point, square) {
    if (!this.#dragging) return;
    this.#dragging.group.position.set(point.x, point.y, point.z);
    if (square !== this.#hover) {
      this.#hover = square;
      this.#refreshHighlights();
    }
    this.#dirty = true;
  }

  #endDrag(from, to) {
    const drag = this.#dragging;
    this.#dragging = null;
    if (this.controls) this.controls.enabled = true;
    if (!drag) {
      if (from && to && from !== to) this.emit('move', { from, to });
      return;
    }

    if (!to || to === from) {
      this.#snapBack(drag);
      return;
    }
    // Put the piece back first: the host decides whether the move is legal, and
    // tells us by sending a new position.
    this.#snapBack(drag, { duration: 0 });
    this.emit('move', { from, to });
  }

  #snapBack(drag, { duration = TIMING.snapback } = {}) {
    const target = squareToWorld(drag.square, this._orientation);
    if (duration === 0) {
      drag.group.position.set(target.x, 0, target.z);
      this.#dirty = true;
      return;
    }
    const start = drag.group.position.clone();
    this.ticker.tween({
      duration,
      ease: easing.easeOutBack,
      onUpdate: (t) => {
        drag.group.position.lerpVectors(start, new Vector3(target.x, 0, target.z), t);
        this.#dirty = true;
      },
    });
  }

  // ------------------------------------------------------------ render loop

  #observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  #downgradeQuality() {
    const index = QUALITY_ORDER.indexOf(this.config.quality);
    if (index <= 0) return;
    const next = QUALITY_ORDER[index - 1];
    this.config.quality = next;
    this.emit('quality', next);
    // Shadows and post are the expensive part; drop them without a full rebuild.
    const tier = this.view.tier;
    this.view.renderer.shadowMap.enabled = next !== 'low';
    this.view.lights.key.castShadow = next !== 'low';
    if (this.view.bloomPass) this.view.bloomPass.enabled = next !== 'low';
    this.view.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, tier.maxPixelRatio));
    this.#dirty = true;
  }

  #startLoop() {
    const frame = (now) => {
      if (this.destroyed) return;
      this.#frameHandle = requestAnimationFrame(frame);
      if (!this.#startedAt) this.#startedAt = now;

      const cameraBefore = this.view.camera.position.clone();
      if (this.controls?.enabled) this.controls.update();
      const cameraMoved = !cameraBefore.equals(this.view.camera.position);

      const tweening = this.ticker.update(now);
      const pulsing = this.#hasPulse();
      if (pulsing) this.highlights.animate(now - this.#startedAt);

      if (this.#dirty || tweening || cameraMoved || pulsing) {
        if (this.config.showNotation) this.#fadeFarNotation();
        this.view.render();
        this.#dirty = false;
        this.frameBudget.sample(now);
      } else {
        // Idle: keep the budget from counting the frames we skipped.
        this.frameBudget.reset();
      }
    };
    this.#frameHandle = requestAnimationFrame(frame);
  }

  #hasPulse() {
    return Boolean(this.#highlightState.check) || Boolean(this.#selected);
  }

  /**
   * Fades the rank/file labels on the far side of the board, which would
   * otherwise read upside down from the current camera angle.
   */
  #fadeFarNotation() {
    const notation = this.board.notation;
    if (!notation) return;
    const { x, z } = this.view.camera.position;
    const opacity = (test) => (test ? 1 : 0.12);
    for (const mesh of notation.children) {
      switch (mesh.name) {
        case 'files-near':
          mesh.material.opacity = opacity(z > -2);
          break;
        case 'files-far':
          mesh.material.opacity = opacity(z < 2);
          break;
        case 'ranks-left':
          mesh.material.opacity = opacity(x < 2);
          break;
        case 'ranks-right':
          mesh.material.opacity = opacity(x > -2);
          break;
        default:
          break;
      }
    }
  }
}
