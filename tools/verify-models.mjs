#!/usr/bin/env node
/**
 * Cross-checks assets/models/** against the ORIGINAL three r80 JSONLoader.
 *
 * The converter reimplements a decoder that was deleted from three years ago,
 * so "it produces a mesh" is not evidence it produces the RIGHT mesh. This runs
 * the retired loader on the legacy source files inside a vm sandbox and compares
 * triangle count, extents, and total surface area — a rotation/order-independent
 * fingerprint that catches a mis-decoded face stream.
 *
 *   node tools/verify-models.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIECES = ['K', 'Q', 'R', 'B', 'N', 'P'];

const legacyThree = ['legacy/js/three.js', 'js/three.js']
  .map((p) => path.join(ROOT, p))
  .find(existsSync);

if (!legacyThree) {
  console.error('verify-models: legacy three r80 build not found; cannot cross-check.');
  process.exit(2);
}

// three r80 is a UMD bundle that expects a browser-ish global; a bare sandbox
// with self/window pointing at itself is enough for the loader path.
const sandbox = { console };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(legacyThree, 'utf8'), sandbox);
const THREE = sandbox.THREE;

if (typeof THREE?.JSONLoader !== 'function') {
  console.error('verify-models: THREE.JSONLoader missing from the legacy build.');
  process.exit(2);
}

const triangleArea = (a, b, c) => {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const cx = uy * vz - uz * vy,
    cy = uz * vx - ux * vz,
    cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
};

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/models/manifest.json'), 'utf8'));
let failures = 0;
let worstArea = 0;

for (const set of manifest.sets) {
  for (const piece of PIECES) {
    const legacy = JSON.parse(
      readFileSync(path.join(ROOT, `assets/chesspieces/${set}/${piece}.json`), 'utf8'),
    );
    const { geometry } = new THREE.JSONLoader().parse(legacy);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const legacyExtent = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    let legacyArea = 0;
    for (const f of geometry.faces) {
      const [va, vb, vc] = [geometry.vertices[f.a], geometry.vertices[f.b], geometry.vertices[f.c]];
      legacyArea += triangleArea([va.x, va.y, va.z], [vb.x, vb.y, vb.z], [vc.x, vc.y, vc.z]);
    }

    const modern = JSON.parse(
      readFileSync(path.join(ROOT, `assets/models/${set}/${piece}.json`), 'utf8'),
    );
    const pos = modern.data.attributes.position.array;
    const idx = modern.data.index.array;
    const at = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], pos[i + a]);
        max[a] = Math.max(max[a], pos[i + a]);
      }
    }
    const modernExtent = max.map((v, i) => v - min[i]);
    let modernArea = 0;
    for (let i = 0; i < idx.length; i += 3) {
      modernArea += triangleArea(at(idx[i]), at(idx[i + 1]), at(idx[i + 2]));
    }

    const triDelta = geometry.faces.length - idx.length / 3;
    const extentErr = Math.max(...legacyExtent.map((v, i) => Math.abs(v - modernExtent[i])));
    const areaErr = Math.abs(legacyArea - modernArea) / legacyArea;
    worstArea = Math.max(worstArea, areaErr);

    if (triDelta !== 0 || extentErr > 1e-3 || areaErr > 1e-4) {
      failures++;
      console.error(
        `FAIL ${set}/${piece}: triDelta=${triDelta} extentErr=${extentErr.toExponential(2)} ` +
          `areaErr=${areaErr.toExponential(2)}`,
      );
    }
  }
}

const total = manifest.sets.length * PIECES.length;
if (failures) {
  console.error(`verify-models: ${failures}/${total} models differ from the r80 reference.`);
  process.exit(1);
}
console.log(
  `verify-models: ${total} models match the r80 reference ` +
    `(worst relative surface-area error ${worstArea.toExponential(2)}).`,
);
