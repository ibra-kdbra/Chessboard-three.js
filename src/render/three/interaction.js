/**
 * Pointer input: hover, click-to-move, and drag-and-drop.
 *
 * Two departures from the original. Square picking is arithmetic against a
 * single plane rather than a raycast against 64 meshes (the old code did 64
 * recursive scene-graph lookups per mousemove). And pointer events replace the
 * separate mouse/touch paths, so a phone, a stylus and a mouse all take the
 * same code path — the old touch handling was a second, subtly different copy.
 *
 * Both interaction styles are supported at once because players expect
 * different ones: tap-tap on a phone, drag on a desktop, and click-click from
 * anyone who learned on lichess.
 */
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { worldToSquare } from './boardGeometry.js';

/** Pointer travel, in CSS pixels, before a press becomes a drag. */
const DRAG_THRESHOLD = 6;

export class BoardInteraction {
  /**
   * @param {{ domElement: HTMLElement, camera: import('three').Camera,
   *           getOrientation: () => 'white'|'black',
   *           pieceAt: (square: string) => object|null,
   *           canPickUp: (square: string) => boolean,
   *           onHover: (square: string|null) => void,
   *           onSelect: (square: string|null) => void,
   *           onDragStart: (square: string) => void,
   *           onDragMove: (point: Vector3, square: string|null) => void,
   *           onDrop: (from: string, to: string|null) => void,
   *           onRightDrag?: (from: string, to: string) => void }} options
   */
  constructor(options) {
    this.options = options;
    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
    this.boardPlane = new Plane(new Vector3(0, 1, 0), 0);
    /** Where a dragged piece floats, so it clears the pieces it passes over. */
    this.dragPlane = new Plane(new Vector3(0, 1, 0), -1.6);
    this.enabled = true;

    this.state = {
      pressed: null,
      pressPoint: null,
      dragging: false,
      selected: null,
      hover: null,
      rightPress: null,
      /** Which pointer owns the drag. A phone reports several at once. */
      pointerId: null,
    };

    this.#bind();
  }

  #handlers = [];

  #bind() {
    const element = this.options.domElement;
    const add = (type, handler, opts) => {
      element.addEventListener(type, handler, opts);
      this.#handlers.push([type, handler, opts]);
    };

    add('pointerdown', (event) => this.#onPointerDown(event));
    add('pointermove', (event) => this.#onPointerMove(event));
    add('pointerup', (event) => this.#onPointerUp(event));
    add('pointercancel', () => this.#cancel());
    add('pointerleave', () => this.#onPointerLeave());
    // Right-drag draws analysis arrows, so the browser menu has to go.
    add('contextmenu', (event) => event.preventDefault());
  }

  /**
   * Screen point to board square.
   *
   * Uses getBoundingClientRect on both axes rather than the drawing buffer
   * size, so this stays correct once the renderer runs at a device pixel ratio
   * above 1 — the original's buffer-relative maths silently broke there.
   */
  squareAt(clientX, clientY) {
    const rect = this.options.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.options.camera);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(this.boardPlane, hit)) return null;
    return worldToSquare(hit.x, hit.z, this.options.getOrientation());
  }

  /** Where a dragged piece should hover, in world space. */
  dragPointAt(clientX, clientY) {
    const rect = this.options.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.options.camera);
    const hit = new Vector3();
    return this.raycaster.ray.intersectPlane(this.dragPlane, hit) ? hit : null;
  }

  #onPointerDown(event) {
    if (!this.enabled) return;
    const square = this.squareAt(event.clientX, event.clientY);

    if (event.button === 2) {
      this.state.rightPress = square;
      return;
    }
    if (event.button !== 0) return;

    // A second finger touching the board mid-drag must not take it over, or
    // the first piece is left levitating where it was dropped.
    if (this.state.pressed && this.state.pointerId !== event.pointerId) return;

    this.state.pressed = square;
    this.state.pressPoint = { x: event.clientX, y: event.clientY };
    this.state.dragging = false;
    this.state.pointerId = event.pointerId;

    if (square && this.options.canPickUp(square)) {
      // Capture so a fast drag that leaves the canvas still reports up.
      this.options.domElement.setPointerCapture?.(event.pointerId);
    }
  }

  #onPointerMove(event) {
    if (!this.enabled) return;
    const square = this.squareAt(event.clientX, event.clientY);

    if (square !== this.state.hover) {
      this.state.hover = square;
      this.options.onHover?.(square);
    }

    if (!this.state.pressed || !this.state.pressPoint) return;
    if (this.state.pointerId !== null && this.state.pointerId !== event.pointerId) return;

    if (!this.state.dragging) {
      const travelled = Math.hypot(
        event.clientX - this.state.pressPoint.x,
        event.clientY - this.state.pressPoint.y,
      );
      if (travelled < DRAG_THRESHOLD) return;
      if (!this.options.canPickUp(this.state.pressed)) return;
      this.state.dragging = true;
      this.options.onDragStart?.(this.state.pressed);
    }

    const point = this.dragPointAt(event.clientX, event.clientY);
    if (point) this.options.onDragMove?.(point, square);
  }

  #onPointerUp(event) {
    if (!this.enabled) return;
    if (
      event.button !== 2 &&
      this.state.pointerId !== null &&
      this.state.pointerId !== event.pointerId
    ) {
      return;
    }
    const square = this.squareAt(event.clientX, event.clientY);
    try {
      this.options.domElement.releasePointerCapture?.(event.pointerId);
    } catch {
      // Some inputs report a pointer that is already gone; releasing it is a
      // courtesy, and throwing here used to strand the board mid-drag.
    }

    if (event.button === 2) {
      const from = this.state.rightPress;
      this.state.rightPress = null;
      if (from && square && from !== square) this.options.onRightDrag?.(from, square);
      return;
    }

    if (this.state.dragging) {
      const from = this.state.pressed;
      this.#reset();
      this.options.onDrop?.(from, square);
      return;
    }

    // A click, not a drag: select, move, or deselect.
    const pressed = this.state.pressed;
    this.#reset();
    if (!square) {
      this.#select(null);
      return;
    }
    if (pressed !== square) {
      // Press and release on different squares without crossing the drag
      // threshold — treat it as a click on the release square.
      this.#clickSquare(square);
      return;
    }
    this.#clickSquare(square);
  }

  #clickSquare(square) {
    const selected = this.state.selected;
    if (selected && selected !== square) {
      this.options.onDrop?.(selected, square);
      this.#select(null);
      return;
    }
    if (selected === square) {
      this.#select(null);
      return;
    }
    if (this.options.canPickUp(square)) this.#select(square);
    else this.#select(null);
  }

  #select(square) {
    this.state.selected = square;
    this.options.onSelect?.(square);
  }

  /**
   * Lets the host clear the selection after a move arrives from elsewhere.
   * `silent` suppresses the event, since the host already knows.
   */
  clearSelection({ silent = false } = {}) {
    if (this.state.selected === null) return;
    this.state.selected = null;
    if (!silent) this.options.onSelect?.(null);
  }

  #onPointerLeave() {
    if (this.state.hover !== null) {
      this.state.hover = null;
      this.options.onHover?.(null);
    }
  }

  #cancel() {
    if (this.state.dragging) this.options.onDrop?.(this.state.pressed, null);
    this.#reset();
  }

  #reset() {
    this.state.pressed = null;
    this.state.pressPoint = null;
    this.state.dragging = false;
    this.state.pointerId = null;
  }

  /** Drops any drag in progress without reporting it as a move. */
  cancelDrag() {
    this.#reset();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.#cancel();
      this.#select(null);
    }
  }

  dispose() {
    for (const [type, handler, opts] of this.#handlers) {
      this.options.domElement.removeEventListener(type, handler, opts);
    }
    this.#handlers = [];
  }
}
