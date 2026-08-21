#!/usr/bin/env node
/**
 * Converts the legacy three.js "JSON Geometry format 3" piece models (exported by
 * Blender's io_three, loaded by the long-removed THREE.JSONLoader) into modern
 * indexed BufferGeometry JSON that THREE.BufferGeometryLoader reads directly.
 *
 * The faces array is a variable-length stream: each record starts with a bitmask
 * byte saying which attributes follow. See decodeFaces() for the layout, which
 * mirrors JSONLoader.parseModel() from three r80.
 *
 *   node tools/convert-pieces.mjs
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'assets/chesspieces');
const OUT_DIR = path.join(ROOT, 'assets/models');
const PIECES = ['K', 'Q', 'R', 'B', 'N', 'P'];

const bit = (value, position) => value & (1 << position);

/**
 * Walks the legacy face stream and emits flat triangle corner records.
 * Quads are split as (a,b,d) + (b,c,d), matching the original loader so the
 * converted mesh is triangle-for-triangle identical to what r80 produced.
 */
function decodeFaces(json) {
  const { faces, vertices, normals = [], uvs = [] } = json;
  const scale = json.scale !== undefined ? 1 / json.scale : 1;
  const uvLayers = uvs.filter((layer) => layer && layer.length).length;

  const tris = [];
  let offset = 0;

  const cornerAt = (vi, ni, uvi) => ({
    p: [vertices[vi * 3] * scale, vertices[vi * 3 + 1] * scale, vertices[vi * 3 + 2] * scale],
    n: ni === null ? null : [normals[ni * 3], normals[ni * 3 + 1], normals[ni * 3 + 2]],
    uv: uvi,
  });

  while (offset < faces.length) {
    const type = faces[offset++];
    const isQuad = bit(type, 0);
    const hasMaterial = bit(type, 1);
    const hasFaceVertexUv = bit(type, 3);
    const hasFaceNormal = bit(type, 4);
    const hasFaceVertexNormal = bit(type, 5);
    const hasFaceColor = bit(type, 6);
    const hasFaceVertexColor = bit(type, 7);

    const corners = isQuad ? 4 : 3;
    const vi = faces.slice(offset, offset + corners);
    offset += corners;

    if (hasMaterial) offset++;

    const uvIdx = new Array(corners).fill(null);
    if (hasFaceVertexUv) {
      for (let layer = 0; layer < uvLayers; layer++) {
        for (let j = 0; j < corners; j++) {
          const idx = faces[offset++];
          if (layer === 0) uvIdx[j] = idx;
        }
      }
    }

    let faceNormal = null;
    if (hasFaceNormal) {
      const ni = faces[offset++];
      faceNormal = [normals[ni * 3], normals[ni * 3 + 1], normals[ni * 3 + 2]];
    }

    const ni = new Array(corners).fill(null);
    if (hasFaceVertexNormal) {
      for (let j = 0; j < corners; j++) ni[j] = faces[offset++];
    }

    if (hasFaceColor) offset++;
    if (hasFaceVertexColor) offset += corners;

    const corner = (j) => {
      const c = cornerAt(vi[j], ni[j], uvIdx[j]);
      if (!c.n) c.n = faceNormal;
      return c;
    };

    if (isQuad) {
      tris.push([corner(0), corner(1), corner(3)]);
      tris.push([corner(1), corner(2), corner(3)]);
    } else {
      tris.push([corner(0), corner(1), corner(2)]);
    }
  }

  if (offset !== faces.length) {
    throw new Error(`face stream desync: consumed ${offset} of ${faces.length}`);
  }
  return { tris, uvLayer: uvs[0] ?? null };
}

/** Welds identical (position, normal, uv) corners so the mesh ships indexed. */
function buildIndexed({ tris, uvLayer }, { positionDigits, normalDigits }) {
  const positions = [];
  const norms = [];
  const uvsOut = [];
  const index = [];
  const lookup = new Map();

  const round = (v, d) => Number(v.toFixed(d));

  for (const tri of tris) {
    for (const c of tri) {
      const p = c.p.map((v) => round(v, positionDigits));
      const n = (c.n ?? [0, 0, 0]).map((v) => round(v, normalDigits));
      const uv =
        uvLayer && c.uv !== null
          ? [round(uvLayer[c.uv * 2], 4), round(uvLayer[c.uv * 2 + 1], 4)]
          : null;
      const key = `${p.join()}|${n.join()}|${uv ? uv.join() : ''}`;
      let i = lookup.get(key);
      if (i === undefined) {
        i = positions.length / 3;
        lookup.set(key, i);
        positions.push(...p);
        norms.push(...n);
        if (uv) uvsOut.push(...uv);
      }
      index.push(i);
    }
  }
  return { positions, norms, uvsOut, index };
}

function boundingBox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max, size: max.map((v, i) => Number((v - min[i]).toFixed(4))) };
}

/**
 * The renderer places pieces by their base centre, so bake that convention into
 * the asset: centred on X/Z, resting on y = 0. Keeps the runtime free of
 * per-set fudge factors.
 */
function normalizeOrigin(positions) {
  const { min, max } = boundingBox(positions);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const floor = min[1];
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = Number((positions[i] - cx).toFixed(5));
    positions[i + 1] = Number((positions[i + 1] - floor).toFixed(5));
    positions[i + 2] = Number((positions[i + 2] - cz).toFixed(5));
  }
  return { offset: [cx, floor, cz] };
}

function toBufferGeometryJson(name, { positions, norms, uvsOut, index }) {
  const attributes = {
    position: { itemSize: 3, type: 'Float32Array', array: positions, normalized: false },
    normal: { itemSize: 3, type: 'Float32Array', array: norms, normalized: false },
  };
  if (uvsOut.length) {
    attributes.uv = { itemSize: 2, type: 'Float32Array', array: uvsOut, normalized: false };
  }
  const maxIndex = index.length ? Math.max(...index) : 0;
  return {
    metadata: { version: 4.6, type: 'BufferGeometry', generator: 'tools/convert-pieces.mjs' },
    uuid: `chess-piece-${name}`,
    type: 'BufferGeometry',
    name,
    data: {
      attributes,
      index: { type: maxIndex > 65535 ? 'Uint32Array' : 'Uint16Array', array: index },
    },
  };
}

const sets = (await readdir(SRC_DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const report = {};

for (const set of sets) {
  await mkdir(path.join(OUT_DIR, set), { recursive: true });
  report[set] = {};
  for (const piece of PIECES) {
    const srcPath = path.join(SRC_DIR, set, `${piece}.json`);
    const json = JSON.parse(await readFile(srcPath, 'utf8'));
    const decoded = decodeFaces(json);
    const built = buildIndexed(decoded, { positionDigits: 4, normalDigits: 3 });
    const { offset } = normalizeOrigin(built.positions);
    const bbox = boundingBox(built.positions);
    const out = toBufferGeometryJson(`${set}-${piece}`, built);
    const outPath = path.join(OUT_DIR, set, `${piece}.json`);
    const text = JSON.stringify(out);
    await writeFile(outPath, text);

    const srcBytes = (await readFile(srcPath)).length;
    report[set][piece] = {
      triangles: decoded.tris.length,
      sourceVertices: json.metadata?.vertices ?? json.vertices.length / 3,
      weldedVertices: built.positions.length / 3,
      height: bbox.size[1],
      footprint: [bbox.size[0], bbox.size[2]],
      recenteredBy: offset.map((v) => Number(v.toFixed(4))),
      bytes: { from: srcBytes, to: text.length },
    };
  }
}

await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ sets, pieces: PIECES, report }, null, 2) + '\n');

for (const set of sets) {
  const totalFrom = PIECES.reduce((s, p) => s + report[set][p].bytes.from, 0);
  const totalTo = PIECES.reduce((s, p) => s + report[set][p].bytes.to, 0);
  const tris = PIECES.reduce((s, p) => s + report[set][p].triangles, 0);
  console.log(
    `${set.padEnd(8)} ${String(tris).padStart(7)} tris  ` +
      `${(totalFrom / 1024).toFixed(0).padStart(5)}K -> ${(totalTo / 1024).toFixed(0).padStart(5)}K  ` +
      `heights ${PIECES.map((p) => report[set][p].height.toFixed(2)).join(' ')}`,
  );
}
