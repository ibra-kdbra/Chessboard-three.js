#!/usr/bin/env node
/**
 * Vendors the runtime dependencies into vendor/ so the site runs from a plain
 * static server with an <script type="importmap"> and no bundler.
 *
 * Only the transitive closure of the addons we actually import is copied, which
 * keeps vendor/ to a few hundred KB instead of the 8.8MB examples/jsm tree.
 *
 *   node tools/vendor.mjs          # minified three build (what we ship)
 *   node tools/vendor.mjs --dev    # readable three build, for debugging
 */
import { readFile, writeFile, mkdir, rm, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'vendor');

// Addon entry points, relative to three/examples/jsm.
const ADDON_ENTRIES = [
  'controls/OrbitControls.js',
  'environments/RoomEnvironment.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/UnrealBloomPass.js',
  'utils/BufferGeometryUtils.js',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function specifiers(source) {
  const out = new Set();
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) out.add(m[1]);
  }
  return [...out];
}

/** Walk the relative-import graph starting from `entries`, copying each file. */
async function copyGraph(srcRoot, destRoot, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = path.join(srcRoot, rel);
    if (!existsSync(src)) throw new Error(`vendor: missing source file ${src}`);
    const source = await readFile(src, 'utf8');
    const dest = path.join(destRoot, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, source);
    for (const spec of specifiers(source)) {
      if (spec.startsWith('.')) {
        queue.push(path.normalize(path.join(path.dirname(rel), spec)));
      } else if (spec !== 'three' && !spec.startsWith('three/addons/')) {
        throw new Error(`vendor: ${rel} imports unvendorable bare specifier "${spec}"`);
      } else if (spec.startsWith('three/addons/')) {
        queue.push(spec.slice('three/addons/'.length));
      }
    }
  }
  return seen;
}

async function pkgVersion(name) {
  return JSON.parse(await readFile(path.join(NM, name, 'package.json'), 'utf8')).version;
}

async function du(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      total += (await readFile(path.join(entry.parentPath ?? entry.path, entry.name))).length;
    }
  }
  return total;
}

const dev = process.argv.includes('--dev');

// Build into a staging tree and swap at the end. Deleting vendor/ up front
// meant any failure below — a missing node_modules, an addon graph that moved
// in a three upgrade — left the site with no runtime at all, 404ing on the
// import map until someone thought to `git checkout -- vendor`.
const STAGE = `${VENDOR}.tmp`;
await rm(STAGE, { recursive: true, force: true });

// --- three core build -------------------------------------------------------
// The minified build is ~3.4x smaller over the wire; --dev swaps in the readable
// one. three.module*.js imports three.core*.js relatively, so both must match.
const threeVersion = await pkgVersion('three');
const threeDest = path.join(STAGE, 'three');
await mkdir(threeDest, { recursive: true });
const suffix = dev ? '' : '.min';
for (const stem of ['three.module', 'three.core']) {
  await writeFile(
    path.join(threeDest, `${stem}.js`),
    (await readFile(path.join(NM, 'three/build', `${stem}${suffix}.js`), 'utf8')).replaceAll(
      `${'three.core'}${suffix}.js`,
      'three.core.js',
    ),
  );
}

// --- three addons -----------------------------------------------------------
const addons = await copyGraph(
  path.join(NM, 'three/examples/jsm'),
  path.join(threeDest, 'addons'),
  ADDON_ENTRIES,
);

// --- chess.js ---------------------------------------------------------------
const chessVersion = await pkgVersion('chess.js');
const chessDest = path.join(STAGE, 'chess.js');
await mkdir(chessDest, { recursive: true });
await writeFile(
  path.join(chessDest, 'chess.js'),
  await readFile(path.join(NM, 'chess.js/dist/esm/chess.js'), 'utf8'),
);

// --- manifest ---------------------------------------------------------------
const manifest = {
  generatedBy: 'tools/vendor.mjs',
  packages: { three: threeVersion, 'chess.js': chessVersion },
  threeBuild: dev ? 'development' : 'minified',
  addonEntries: ADDON_ENTRIES,
  addonFileCount: addons.size,
};
await writeFile(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Everything succeeded, so the swap is safe. Replacing the whole tree keeps the
// old behaviour of dropping addons a version bump no longer needs.
await rm(VENDOR, { recursive: true, force: true });
await rename(STAGE, VENDOR);

console.log(`three@${threeVersion} (${dev ? 'dev' : 'min'})  chess.js@${chessVersion}`);
console.log(`addons: ${addons.size} files`);
console.log(`vendor/: ${((await du(VENDOR)) / 1024 / 1024).toFixed(2)} MB`);
