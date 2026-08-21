/**
 * Board overlays: selection, legal-move dots, last move, check, hover, and the
 * analysis arrows.
 *
 * All of it is pooled. Legal-move dots in particular churn on every click, and
 * allocating 30 meshes and materials per selection is exactly the kind of thing
 * that shows up as a hitch on a phone.
 *
 * Everything sits a hair above the board and writes no depth, so overlays never
 * z-fight with the squares and never occlude each other unpredictably.
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three';
import { SQUARE_SIZE, squareToWorld } from './boardGeometry.js';

const OVERLAY_Y = 0.014;
const ARROW_Y = 0.09;

function flatMaterial(color, opacity, { additive = false } = {}) {
  const material = new MeshBasicMaterial({
    color: new Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    side: DoubleSide,
  });
  if (additive) material.blending = AdditiveBlending;
  return material;
}

/** Rounded square, so the tint hugs the inlay line rather than sitting on it. */
function roundedSquareGeometry(size, radius) {
  const half = size / 2;
  const shape = new Shape();
  shape.moveTo(-half + radius, -half);
  shape.lineTo(half - radius, -half);
  shape.quadraticCurveTo(half, -half, half, -half + radius);
  shape.lineTo(half, half - radius);
  shape.quadraticCurveTo(half, half, half - radius, half);
  shape.lineTo(-half + radius, half);
  shape.quadraticCurveTo(-half, half, -half, half - radius);
  shape.lineTo(-half, -half + radius);
  shape.quadraticCurveTo(-half, -half, -half + radius, -half);
  const geometry = new ShapeGeometry(shape, 6);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * A pool of identical meshes. `begin()`/`show()`/`end()` per frame-ish update:
 * anything not shown this round is hidden rather than destroyed.
 */
class MeshPool {
  constructor(parent, build) {
    this.parent = parent;
    this.build = build;
    this.items = [];
    this.used = 0;
  }

  begin() {
    this.used = 0;
  }

  next() {
    if (this.used === this.items.length) {
      const mesh = this.build();
      mesh.renderOrder = 2;
      this.parent.add(mesh);
      this.items.push(mesh);
    }
    const mesh = this.items[this.used++];
    mesh.visible = true;
    return mesh;
  }

  end() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false;
  }

  dispose() {
    for (const mesh of this.items) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.items = [];
  }
}

export class HighlightLayer {
  /**
   * @param {object} theme
   * @param {{ orientation?: 'white'|'black' }} [options]
   */
  constructor(theme, { orientation = 'white' } = {}) {
    this.group = new Group();
    this.group.name = 'highlights';
    this.orientation = orientation;
    this.palette = theme.highlights;

    // Shared geometry — the pools differ only by material.
    this.geometries = {
      tint: roundedSquareGeometry(SQUARE_SIZE - 0.09, 0.22),
      dot: (() => {
        const geometry = new CylinderGeometry(SQUARE_SIZE * 0.15, SQUARE_SIZE * 0.15, 0.02, 24);
        return geometry;
      })(),
      captureRing: (() => {
        const geometry = new RingGeometry(SQUARE_SIZE * 0.38, SQUARE_SIZE * 0.46, 32);
        geometry.rotateX(-Math.PI / 2);
        return geometry;
      })(),
      selectRing: (() => {
        const geometry = new RingGeometry(SQUARE_SIZE * 0.42, SQUARE_SIZE * 0.48, 40);
        geometry.rotateX(-Math.PI / 2);
        return geometry;
      })(),
    };

    const tint = (color, opacity) => () =>
      new Mesh(this.geometries.tint, flatMaterial(color, opacity));

    this.pools = {
      // Kept light: at higher opacity this stops reading as a tint on the
      // square and starts reading as a coloured tile covering it.
      lastMove: new MeshPool(this.group, tint(this.palette.lastMove, 0.3)),
      selected: new MeshPool(
        this.group,
        () =>
          new Mesh(
            this.geometries.selectRing,
            flatMaterial(this.palette.selected, 0.9, { additive: true }),
          ),
      ),
      check: new MeshPool(this.group, tint(this.palette.check, 0.6)),
      hover: new MeshPool(this.group, tint(this.palette.hover, 0.14)),
      premove: new MeshPool(this.group, tint(this.palette.premove, 0.4)),
      hint: new MeshPool(this.group, tint(this.palette.hint, 0.45)),
      threatened: new MeshPool(
        this.group,
        () => new Mesh(this.geometries.captureRing, flatMaterial(this.palette.check, 0.55)),
      ),
      legal: new MeshPool(
        this.group,
        () => new Mesh(this.geometries.dot, flatMaterial(this.palette.legal, 0.75)),
      ),
      legalCapture: new MeshPool(
        this.group,
        () => new Mesh(this.geometries.captureRing, flatMaterial(this.palette.legalCapture, 0.8)),
      ),
    };

    this.arrows = new Group();
    this.arrows.name = 'arrows';
    this.group.add(this.arrows);
    this.arrowMeshes = [];
  }

  setOrientation(orientation) {
    this.orientation = orientation;
  }

  applyTheme(theme) {
    this.palette = theme.highlights;
    const colors = {
      lastMove: this.palette.lastMove,
      selected: this.palette.selected,
      check: this.palette.check,
      hover: this.palette.hover,
      premove: this.palette.premove,
      hint: this.palette.hint,
      legal: this.palette.legal,
      legalCapture: this.palette.legalCapture,
      threatened: this.palette.check,
    };
    for (const [key, pool] of Object.entries(this.pools)) {
      for (const mesh of pool.items) mesh.material.color.set(colors[key]);
    }
  }

  #place(mesh, square, y = OVERLAY_Y) {
    const { x, z } = squareToWorld(square, this.orientation);
    mesh.position.set(x, y, z);
  }

  /**
   * Replaces the whole overlay state in one call. Passing the full desired
   * state each time rather than add/remove pairs is what keeps this in sync
   * with the game — there is no incremental state to get wrong.
   *
   * @param {{ selected?: string|null, legal?: Array<{to: string, capture: boolean}>,
   *           lastMove?: {from: string, to: string}|null, check?: string|null,
   *           hover?: string|null, premove?: {from: string, to: string}|null,
   *           hint?: {from: string, to: string}|null, threatened?: string[] }} state
   */
  update(state = {}) {
    for (const pool of Object.values(this.pools)) pool.begin();

    if (state.lastMove) {
      for (const square of [state.lastMove.from, state.lastMove.to]) {
        this.#place(this.pools.lastMove.next(), square);
      }
    }
    if (state.hint) {
      for (const square of [state.hint.from, state.hint.to]) {
        this.#place(this.pools.hint.next(), square);
      }
    }
    if (state.premove) {
      for (const square of [state.premove.from, state.premove.to]) {
        this.#place(this.pools.premove.next(), square);
      }
    }
    for (const square of state.threatened ?? []) {
      this.#place(this.pools.threatened.next(), square, OVERLAY_Y + 0.006);
    }
    if (state.hover) this.#place(this.pools.hover.next(), state.hover);
    if (state.selected) this.#place(this.pools.selected.next(), state.selected, OVERLAY_Y + 0.004);
    if (state.check) this.#place(this.pools.check.next(), state.check);

    for (const move of state.legal ?? []) {
      const pool = move.capture ? this.pools.legalCapture : this.pools.legal;
      this.#place(pool.next(), move.to, OVERLAY_Y + 0.01);
    }

    for (const pool of Object.values(this.pools)) pool.end();
  }

  /** Pulses the check tint; called from the render loop. */
  animate(elapsedMs) {
    const pulse = 0.45 + 0.25 * Math.sin(elapsedMs / 190);
    for (const mesh of this.pools.check.items) {
      if (mesh.visible) mesh.material.opacity = pulse;
    }
    for (const mesh of this.pools.selected.items) {
      if (mesh.visible) mesh.material.opacity = 0.7 + 0.2 * Math.sin(elapsedMs / 260);
    }
  }

  /**
   * Draws analysis arrows. Passing the full list replaces whatever was there.
   * @param {Array<{from: string, to: string, color?: number, opacity?: number, width?: number}>} arrows
   */
  setArrows(arrows = []) {
    for (const mesh of this.arrowMeshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.arrows.remove(mesh);
    }
    this.arrowMeshes = [];

    for (const arrow of arrows) {
      const from = squareToWorld(arrow.from, this.orientation);
      const to = squareToWorld(arrow.to, this.orientation);
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;

      const width = arrow.width ?? 0.28;
      const headLength = Math.min(0.9, length * 0.32);
      const shaftLength = Math.max(0.05, length - headLength);

      const material = flatMaterial(arrow.color ?? this.palette.hint, arrow.opacity ?? 0.85);
      // Arrows are guidance, not scenery: they read through the pieces.
      material.depthTest = false;

      // Cylinders and cones are built along +Y; aim that axis down the move.
      const direction = new Vector3(dx / length, 0, dz / length);
      const orientation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction);
      const along = (distance) =>
        new Vector3(from.x, ARROW_Y, from.z).addScaledVector(direction, distance);

      const shaft = new Mesh(new CylinderGeometry(width, width, shaftLength, 12), material);
      shaft.quaternion.copy(orientation);
      shaft.position.copy(along(shaftLength / 2));
      shaft.renderOrder = 4;

      const head = new Mesh(new ConeGeometry(width * 2.3, headLength, 16), material);
      head.quaternion.copy(orientation);
      head.position.copy(along(shaftLength + headLength / 2));
      head.renderOrder = 4;

      this.arrows.add(shaft, head);
      this.arrowMeshes.push(shaft, head);
    }
  }

  clear() {
    this.update({});
    this.setArrows([]);
  }

  dispose() {
    for (const pool of Object.values(this.pools)) pool.dispose();
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.setArrows([]);
    this.group.clear();
  }
}
