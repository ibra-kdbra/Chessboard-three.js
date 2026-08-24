/**
 * Piece geometry loading and mesh management.
 *
 * Geometry is fetched once per set and shared by every mesh of that piece;
 * materials are cloned per mesh because fades, highlights and capture effects
 * all need to touch one piece without touching its twins.
 *
 * Sets are authored at different scales — the iconic set's pieces are short and
 * wide, the minions set tall and narrow — so each set is normalised at load
 * time against the manifest rather than by hard-coded per-set fudge factors.
 */
import {
  BufferGeometryLoader,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Sphere,
  Vector3,
} from 'three';
import { buildMaterial } from './materials.js';
import { contactShadowTexture } from './textures.js';
import { SQUARE_SIZE, squareToWorld } from './boardGeometry.js';

export { PIECE_SETS } from './pieceSets.js';

export const PIECE_CODES = Object.freeze(['K', 'Q', 'R', 'B', 'N', 'P']);

/** Pieces are scaled to roughly this tall, unless their footprint objects. */
const TARGET_KING_HEIGHT = 3.0;
/**
 * ...and no wider than this.
 *
 * Measured against the set's SECOND widest piece, not its widest. The iconic
 * set has one outlier — a queen wider than she is tall — and constraining on
 * her alone shrank the whole set to 56% of the height the others render at.
 * Letting a single piece overhang its square slightly is a much smaller
 * problem than a set that looks like it belongs to a different game.
 */
const MAX_FOOTPRINT = SQUARE_SIZE * 0.95;

const geometryCache = new Map();
const manifestCache = { promise: null, data: null };

async function loadManifest(basePath) {
  if (manifestCache.data) return manifestCache.data;
  if (!manifestCache.promise) {
    manifestCache.promise = fetch(`${basePath}/manifest.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`piece manifest ${response.status}`);
        return response.json();
      })
      .then((data) => {
        manifestCache.data = data;
        return data;
      });
  }
  return manifestCache.promise;
}

/**
 * Uniform scale for a set: fit the king to the target height, but back off if
 * that would make the widest piece overflow its square.
 */
export function setScale(manifest, set) {
  const report = manifest?.report?.[set];
  if (!report) return 1;
  const kingHeight = report.K?.height ?? TARGET_KING_HEIGHT;
  const footprints = PIECE_CODES.map((code) =>
    Math.max(...(report[code]?.footprint ?? [1, 1])),
  ).sort((a, b) => b - a);
  const constraining = footprints[1] ?? footprints[0];
  return Math.min(TARGET_KING_HEIGHT / kingHeight, MAX_FOOTPRINT / constraining);
}

/**
 * Loads every piece geometry for a set.
 * @returns {Promise<{ geometries: Record<string, import('three').BufferGeometry>, scale: number }>}
 */
export async function loadPieceSet(set, { basePath = 'assets/models' } = {}) {
  const cacheKey = `${basePath}/${set}`;
  if (geometryCache.has(cacheKey)) return geometryCache.get(cacheKey);

  const entry = (async () => {
    const manifest = await loadManifest(basePath);
    const loader = new BufferGeometryLoader();
    const geometries = {};
    await Promise.all(
      PIECE_CODES.map(async (code) => {
        const response = await fetch(`${basePath}/${set}/${code}.json`);
        if (!response.ok) throw new Error(`piece ${set}/${code}: ${response.status}`);
        const geometry = loader.parse(await response.json());
        geometry.computeBoundingBox();
        // A bounding sphere is needed for frustum culling and for the drag
        // raycast; the loader does not compute one from a parsed file.
        geometry.computeBoundingSphere();
        geometries[code] = geometry;
      }),
    );
    return { geometries, scale: setScale(manifest, set), manifest };
  })();

  geometryCache.set(cacheKey, entry);
  return entry;
}

/** Frees cached geometry for a set (or all sets). */
export function disposePieceSet(set, { basePath = 'assets/models' } = {}) {
  const keys = set ? [`${basePath}/${set}`] : [...geometryCache.keys()];
  for (const key of keys) {
    const entry = geometryCache.get(key);
    if (!entry) continue;
    Promise.resolve(entry).then(({ geometries }) => {
      for (const geometry of Object.values(geometries)) geometry.dispose();
    });
    geometryCache.delete(key);
  }
}

/**
 * Owns every piece mesh on the board and the square→mesh index the renderer
 * animates against.
 */
export class PieceFactory {
  /**
   * @param {{ geometries: object, scale: number }} assets
   * @param {object} theme
   * @param {{ quality?: string, contactShadows?: boolean }} [options]
   */
  constructor(assets, theme, { quality = 'high', contactShadows = true } = {}) {
    this.assets = assets;
    this.quality = quality;
    this.contactShadows = contactShadows && quality !== 'low';
    this.materials = {
      w: buildMaterial(theme.pieces.white, { quality }),
      b: buildMaterial(theme.pieces.black, { quality }),
    };
    this.shadowMaterial = this.contactShadows
      ? new MeshBasicMaterial({
          map: contactShadowTexture(),
          transparent: true,
          depthWrite: false,
          opacity: 0.6,
        })
      : null;
    this.shadowGeometry = this.contactShadows
      ? (() => {
          const geometry = new PlaneGeometry(SQUARE_SIZE * 0.95, SQUARE_SIZE * 0.95);
          geometry.rotateX(-Math.PI / 2);
          return geometry;
        })()
      : null;
  }

  /**
   * Builds one piece.
   * @param {string} code e.g. 'wK'
   * @returns {Group} a group whose first child is the piece mesh
   */
  create(code) {
    const color = code[0];
    const type = code[1].toUpperCase();
    const geometry = this.assets.geometries[type];
    if (!geometry) throw new Error(`no geometry for piece ${code}`);

    const group = new Group();
    group.name = `piece-${code}`;
    group.userData.pieceCode = code;

    const mesh = new Mesh(geometry, this.materials[color].clone());
    mesh.scale.setScalar(this.assets.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Black pieces face the other way, or every knight looks the same way.
    if (color === 'b') group.rotation.y = Math.PI;
    mesh.userData.pieceCode = code;
    group.add(mesh);
    group.userData.mesh = mesh;

    if (this.contactShadows) {
      // Cloned per piece: the fade-out of a captured piece animates its shadow
      // material's opacity, and on a shared material that faded every shadow on
      // the board at once.
      const shadow = new Mesh(this.shadowGeometry, this.shadowMaterial.clone());
      shadow.position.y = 0.012;
      shadow.renderOrder = -1;
      shadow.userData.isContactShadow = true;
      group.add(shadow);
      group.userData.contactShadow = shadow;
    }

    // The group's own sphere is what culling and picking test against.
    const radius = (geometry.boundingSphere?.radius ?? 1) * this.assets.scale;
    group.userData.boundingSphere = new Sphere(new Vector3(), radius);
    return group;
  }

  /** Positions a piece on a square, seated on the board surface. */
  place(group, square, orientation = 'white') {
    const { x, z } = squareToWorld(square, orientation);
    group.position.set(x, 0, z);
    group.userData.square = square;
    return group;
  }

  /** Swaps in a new theme's materials without rebuilding any geometry. */
  applyTheme(theme, pieces) {
    for (const color of ['w', 'b']) this.materials[color].dispose();
    this.materials = {
      w: buildMaterial(theme.pieces.white, { quality: this.quality }),
      b: buildMaterial(theme.pieces.black, { quality: this.quality }),
    };
    for (const group of pieces) {
      const mesh = group.userData.mesh;
      const color = group.userData.pieceCode[0];
      mesh.material.dispose();
      mesh.material = this.materials[color].clone();
    }
  }

  dispose(group) {
    group.userData.mesh?.material.dispose();
    group.userData.contactShadow?.material.dispose();
    group.clear();
  }

  disposeShared() {
    for (const material of Object.values(this.materials)) material.dispose();
    this.shadowMaterial?.dispose();
    this.shadowGeometry?.dispose();
  }
}
