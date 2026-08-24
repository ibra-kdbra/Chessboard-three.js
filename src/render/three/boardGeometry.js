/**
 * The board, built procedurally.
 *
 * Two things differ from the original widget. The 64 squares are merged into
 * two meshes (one per colour) instead of 64 separate ones, which turns 64 draw
 * calls into 2; and nothing raycasts against them, because a square can be
 * found from a ray/plane intersection with two divisions. Highlights are
 * separate pooled decals, so the merge costs no interactivity.
 *
 * World layout matches the original convention so the existing piece models
 * keep their scale: squares are 2 units, a1 is at (-7, +7), h8 at (+7, -7), and
 * the playing surface is y = 0.
 */
import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FILES, RANKS, isLightSquare } from '../../core/constants.js';
import { buildMaterial } from './materials.js';

export const SQUARE_SIZE = 2;
export const BOARD_SPAN = SQUARE_SIZE * 8;
export const SQUARE_THICKNESS = 0.5;
export const FRAME_WIDTH = 2.1;
export const FRAME_HEIGHT = 0.72;
/** Height of the frame's upper face. The playing surface is y = 0. */
export const FRAME_TOP = 0.16;

/** World position of a square's centre, on the playing surface. */
export function squareToWorld(square, orientation = 'white') {
  const file = FILES.indexOf(square[0]);
  const rank = RANKS.indexOf(square[1]);
  const x = SQUARE_SIZE * (file - 3.5);
  const z = SQUARE_SIZE * (3.5 - rank);
  return orientation === 'black' ? { x: -x, z: -z } : { x, z };
}

/**
 * Inverse of squareToWorld. Returns null off the board, so a click on the frame
 * or the backdrop is simply not a square.
 */
export function worldToSquare(x, z, orientation = 'white') {
  const wx = orientation === 'black' ? -x : x;
  const wz = orientation === 'black' ? -z : z;
  const file = Math.round(wx / SQUARE_SIZE + 3.5);
  const rank = Math.round(3.5 - wz / SQUARE_SIZE);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  // Reject a hit that lands in the gap outside a square's actual footprint.
  const centre = { x: SQUARE_SIZE * (file - 3.5), z: SQUARE_SIZE * (3.5 - rank) };
  if (Math.abs(wx - centre.x) > SQUARE_SIZE / 2 || Math.abs(wz - centre.z) > SQUARE_SIZE / 2) {
    return null;
  }
  return `${FILES[file]}${RANKS[rank]}`;
}

/** Rounded-corner square ring for the frame, extruded with a bevel. */
function frameShape() {
  const inner = BOARD_SPAN / 2;
  const outer = inner + FRAME_WIDTH;
  const shape = new Shape();
  const radius = 0.9;
  // Outer outline, corners eased so the frame catches a highlight.
  shape.moveTo(-outer + radius, -outer);
  shape.lineTo(outer - radius, -outer);
  shape.quadraticCurveTo(outer, -outer, outer, -outer + radius);
  shape.lineTo(outer, outer - radius);
  shape.quadraticCurveTo(outer, outer, outer - radius, outer);
  shape.lineTo(-outer + radius, outer);
  shape.quadraticCurveTo(-outer, outer, -outer, outer - radius);
  shape.lineTo(-outer, -outer + radius);
  shape.quadraticCurveTo(-outer, -outer, -outer + radius, -outer);

  const hole = new Shape();
  hole.moveTo(-inner, -inner);
  hole.lineTo(inner, -inner);
  hole.lineTo(inner, inner);
  hole.lineTo(-inner, inner);
  shape.holes.push(hole);
  return shape;
}

/**
 * Notation for one board edge, drawn to a canvas — no font asset needed.
 *
 * `glyphRotation` turns each character within its cell. The rank strips run
 * along the board's side, so without it the digits lie on their side; a real
 * board prints them upright to whoever is sitting at that edge, which is what
 * the far-side fade then compensates for.
 */
function notationTexture(labels, { color = '#e8d3a8', size = 1024, glyphRotation = 0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.round(size / 8);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.round(canvas.height * 0.62)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = canvas.width / labels.length;
  labels.forEach((label, index) => {
    ctx.save();
    ctx.translate(step * (index + 0.5), canvas.height * 0.54);
    if (glyphRotation) ctx.rotate(glyphRotation);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Builds the board.
 *
 * @param {object} theme a theme from themes.js
 * @param {{ quality?: string, showNotation?: boolean }} [options]
 * @returns {{ group: Group, squares: {light: Mesh, dark: Mesh}, frame: Mesh|null,
 *            notation: Group|null, pickPlane: Mesh, dispose: () => void }}
 */
export function buildBoard(theme, { quality = 'high', showNotation = true } = {}) {
  const group = new Group();
  group.name = 'board';
  const disposables = [];

  // --- squares, merged by colour -------------------------------------------
  const lightGeometries = [];
  const darkGeometries = [];
  for (const file of FILES) {
    for (const rank of RANKS) {
      const square = `${file}${rank}`;
      const { x, z } = squareToWorld(square);
      // A hair under full size leaves a dark seam that reads as inlay.
      const geometry = new BoxGeometry(SQUARE_SIZE - 0.045, SQUARE_THICKNESS, SQUARE_SIZE - 0.045);
      geometry.translate(x, -SQUARE_THICKNESS / 2, z);
      (isLightSquare(square) ? lightGeometries : darkGeometries).push(geometry);
    }
  }

  const lightMaterial = buildMaterial(theme.board.light, { quality, textureScale: 1 });
  const darkMaterial = buildMaterial(theme.board.dark, { quality, textureScale: 1 });
  const lightMesh = new Mesh(applyPlanarUV(mergeGeometries(lightGeometries)), lightMaterial);
  const darkMesh = new Mesh(applyPlanarUV(mergeGeometries(darkGeometries)), darkMaterial);
  for (const geometry of [...lightGeometries, ...darkGeometries]) geometry.dispose();
  for (const mesh of [lightMesh, darkMesh]) {
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);
    disposables.push(mesh.geometry, mesh.material);
  }

  // --- inlay plate under the seams -----------------------------------------
  const plateGeometry = new BoxGeometry(BOARD_SPAN + 0.02, 0.12, BOARD_SPAN + 0.02);
  plateGeometry.translate(0, -SQUARE_THICKNESS - 0.06, 0);
  const plateMaterial = buildMaterial(
    { kind: 'plain', color: theme.board.inlay ?? 0x8a7550, roughness: 0.5, metalness: 0.2 },
    { quality: 'low' },
  );
  const plate = new Mesh(plateGeometry, plateMaterial);
  plate.receiveShadow = true;
  group.add(plate);
  disposables.push(plateGeometry, plateMaterial);

  // --- frame ---------------------------------------------------------------
  // The bevel extends the extrusion by bevelThickness at BOTH ends, so the
  // solid actually spans -bevelThickness .. depth + bevelThickness. Seating it
  // by `depth` alone leaves the real top 0.12 higher than intended, which is
  // enough to bury anything drawn on the frame inside it.
  const bevelThickness = 0.12;
  const frameGeometry = new ExtrudeGeometry(frameShape(), {
    depth: FRAME_HEIGHT,
    bevelEnabled: true,
    bevelThickness,
    bevelSize: 0.12,
    bevelSegments: quality === 'low' ? 1 : 3,
    curveSegments: quality === 'low' ? 4 : 12,
  });
  // Extrude builds on the XY plane; stand it up, then seat it so its TOP face
  // lands at FRAME_TOP — just proud of the playing surface. Translating by the
  // extrusion depth instead puts the top a whole frame-height in the air, which
  // hides anything drawn on it.
  frameGeometry.rotateX(-Math.PI / 2);
  frameGeometry.translate(0, FRAME_TOP - FRAME_HEIGHT - bevelThickness, 0);
  applyPlanarUV(frameGeometry);
  const frameMaterial = buildMaterial(theme.board.frame, { quality, textureScale: 1 });
  const frame = new Mesh(frameGeometry, frameMaterial);
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);
  disposables.push(frameGeometry, frameMaterial);

  // --- notation ------------------------------------------------------------
  let notation = null;
  if (showNotation) {
    notation = new Group();
    notation.name = 'notation';
    const inset = BOARD_SPAN / 2 + FRAME_WIDTH / 2;
    const y = FRAME_TOP + 0.012;
    const colour = `#${(theme.board.inlay ?? 0xe8d3a8).toString(16).padStart(6, '0')}`;

    const edges = [
      { id: 'files-near', labels: [...FILES], position: [0, y, inset], rotation: 0, glyph: 0 },
      {
        id: 'files-far',
        labels: [...FILES].reverse(),
        position: [0, y, -inset],
        rotation: Math.PI,
        glyph: 0,
      },
      {
        id: 'ranks-left',
        labels: [...RANKS].reverse(),
        position: [-inset, y, 0],
        rotation: -Math.PI / 2,
        glyph: -Math.PI / 2,
      },
      {
        id: 'ranks-right',
        labels: [...RANKS],
        position: [inset, y, 0],
        rotation: Math.PI / 2,
        glyph: Math.PI / 2,
      },
    ];

    for (const edge of edges) {
      const texture = notationTexture(edge.labels, { color: colour, glyphRotation: edge.glyph });
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const geometry = new PlaneGeometry(BOARD_SPAN, FRAME_WIDTH * 0.62);
      const mesh = new Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = edge.rotation;
      mesh.position.set(...edge.position);
      mesh.name = edge.id;
      notation.add(mesh);
      disposables.push(geometry, material, texture);
    }
    group.add(notation);
  }

  // --- invisible pick plane -------------------------------------------------
  // One target for every square. Sized to the playing area so a click on the
  // frame misses it, which is what we want.
  const pickGeometry = new PlaneGeometry(BOARD_SPAN, BOARD_SPAN);
  const pickPlane = new Mesh(pickGeometry, new MeshBasicMaterial({ visible: false }));
  pickPlane.rotation.x = -Math.PI / 2;
  pickPlane.name = 'pick-plane';
  group.add(pickPlane);
  disposables.push(pickGeometry, pickPlane.material);

  return {
    group,
    squares: { light: lightMesh, dark: darkMesh },
    frame,
    notation,
    pickPlane,
    dispose() {
      for (const item of disposables) item.dispose?.();
      group.clear();
    },
  };
}

/** A flat disc used for legal-move dots and selection rings. */
export function buildSquareDecal(radius, segments = 32) {
  const geometry = new CircleGeometry(radius, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** A square outline decal, for last-move and check tints. */
export function buildSquareTint() {
  const geometry = new PlaneGeometry(SQUARE_SIZE - 0.045, SQUARE_SIZE - 0.045);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export const BOARD_UP = new Vector3(0, 1, 0);

/**
 * Replaces a geometry's UVs with a planar projection from world XZ.
 *
 * The squares are merged from 64 boxes, each of which carries its own 0..1 UVs.
 * Left alone, that tiles the wood once per square and the board reads as a
 * printed crosshatch. Projecting from position instead lets one continuous
 * plank pattern run across the whole surface, which is what an inlaid board
 * actually looks like.
 */
export function applyPlanarUV(
  geometry,
  { span = BOARD_SPAN + FRAME_WIDTH * 2, offset = 0.5 } = {},
) {
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = position.getX(i) / span + offset;
    uv[i * 2 + 1] = position.getZ(i) / span + offset;
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  return geometry;
}
