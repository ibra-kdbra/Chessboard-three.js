/**
 * Procedural textures.
 *
 * Every surface in the scene is generated into a canvas at runtime. That keeps
 * the repository free of binary texture assets, lets a theme recolour its wood
 * or marble without shipping a second image, and means the board looks right at
 * any resolution because the maps are drawn to fit the device.
 *
 * Textures are cached by their full parameter set — themes share generators and
 * would otherwise redraw the same 1024² canvas on every switch.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, DataTexture, RGBAFormat } from 'three';

const cache = new Map();

function cached(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

export function disposeTextureCache() {
  for (const texture of cache.values()) texture.dispose?.();
  cache.clear();
}

function makeCanvas(size) {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size });
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Deterministic value noise, so a texture looks the same on every load. */
function makeNoise(seed = 1) {
  let state = seed >>> 0 || 1;
  const random = () => {
    // xorshift32 — fast, and good enough for grain.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const table = Array.from({ length: 256 }, random);
  const smooth = (t) => t * t * (3 - 2 * t);
  return {
    random,
    /** 2D value noise in 0..1. */
    at(x, y) {
      const xi = Math.floor(x) & 255;
      const yi = Math.floor(y) & 255;
      const xf = smooth(x - Math.floor(x));
      const yf = smooth(y - Math.floor(y));
      // Hash the lattice corner into the value table; the primes just decorrelate
      // the two axes so the grid does not show through as a checker pattern.
      const c00 = table[(xi * 7 + yi * 131) & 255];
      const c10 = table[((xi + 1) * 7 + yi * 131) & 255];
      const c01 = table[(xi * 7 + (yi + 1) * 131) & 255];
      const c11 = table[((xi + 1) * 7 + (yi + 1) * 131) & 255];
      const top = c00 + (c10 - c00) * xf;
      const bottom = c01 + (c11 - c01) * xf;
      return top + (bottom - top) * yf;
    },
  };
}

/** Sums octaves of value noise for a natural, non-repeating look. */
function fbm(noise, x, y, octaves = 5) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    value += noise.at(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)));

function mixColor(a, b, t) {
  return [
    clamp255(a[0] + (b[0] - a[0]) * t),
    clamp255(a[1] + (b[1] - a[1]) * t),
    clamp255(a[2] + (b[2] - a[2]) * t),
  ];
}

function hexToRgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function finish(canvas, { repeat = 1, srgb = true }) {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Wood grain.
 *
 * A plain warped sine gives evenly spaced, symmetric stripes — corrugated card,
 * not timber. Real growth rings are asymmetric: a wide band of pale earlywood
 * ending in a narrow dark line of latewood. So the ring phase is taken as a
 * sawtooth and raised to a high power, which puts the dark line at the end of
 * each cycle, and the phase is warped hard enough (turbulence in whole ring
 * cycles) for the rings to wander into the cathedral arches you see on a
 * flat-sawn board.
 */
export function woodTexture({
  size = 1024,
  light = 0xc8a06a,
  dark = 0x6b4526,
  rings = 12,
  turbulence = 2.6,
  sharpness = 6,
  pores = 0.05,
  seed = 7,
  angle = 0,
} = {}) {
  const key = `wood:${size}:${light}:${dark}:${rings}:${turbulence}:${sharpness}:${pores}:${seed}:${angle}`;
  return cached(key, () => {
    const { canvas, ctx } = makeCanvas(size);
    const image = ctx.createImageData(size, size);
    const noise = makeNoise(seed);
    const lightRgb = hexToRgb(light);
    const darkRgb = hexToRgb(dark);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        // `across` runs perpendicular to the grain, `along` down its length.
        const across = u * cos - v * sin;
        const along = u * sin + v * cos;

        // Stretched along the grain so rings stay roughly parallel while still
        // bending; this is what produces the arches.
        const warp = (fbm(noise, across * 1.6, along * 0.4, 5) - 0.5) * turbulence;
        const phase = across * rings + warp;
        const saw = phase - Math.floor(phase);

        // Latewood: near zero for most of the ring, then climbing sharply.
        let value = saw ** sharpness;
        // Fine pores scratched along the grain.
        value += (fbm(noise, across * 130, along * 6, 2) - 0.5) * pores * 2;
        // Broad tonal drift, so no two areas of the board match exactly.
        value += (fbm(noise, across * 0.9, along * 0.7, 3) - 0.5) * 0.18;

        const t = 1 - Math.max(0, Math.min(1, value));
        const [r, g, b] = mixColor(darkRgb, lightRgb, t);
        const offset = (y * size + x) * 4;
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return finish(canvas, { repeat: 1 });
  });
}

/**
 * Marble: fbm-perturbed sine bands give the classic vein structure, with a
 * second, sharper pass for the thin bright veins.
 */
export function marbleTexture({
  size = 1024,
  base = 0xf2efe6,
  vein = 0x9a9384,
  scale = 3.2,
  turbulence = 6,
  seed = 21,
} = {}) {
  return cached(`marble:${size}:${base}:${vein}:${scale}:${turbulence}:${seed}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const image = ctx.createImageData(size, size);
    const noise = makeNoise(seed);
    const baseRgb = hexToRgb(base);
    const veinRgb = hexToRgb(vein);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const warp = fbm(noise, u * scale, v * scale, 6);
        const band = Math.abs(Math.sin((u + v) * Math.PI * scale + warp * turbulence));
        const thin = Math.max(0, 1 - Math.abs(band - 0.12) * 14) * 0.7;
        const t = Math.min(1, band ** 2.6 * 0.75 + thin);
        const [r, g, b] = mixColor(baseRgb, veinRgb, t);
        const offset = (y * size + x) * 4;
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return finish(canvas, { repeat: 1 });
  });
}

/** Fine isotropic grain, for the subtle roughness variation on stone or metal. */
export function roughnessTexture({
  size = 512,
  base = 0.5,
  spread = 0.25,
  scale = 90,
  seed = 3,
} = {}) {
  return cached(`rough:${size}:${base}:${spread}:${scale}:${seed}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const image = ctx.createImageData(size, size);
    const noise = makeNoise(seed);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = fbm(noise, (x / size) * scale, (y / size) * scale, 3);
        const level = clamp255((base + (value - 0.5) * spread * 2) * 255);
        const offset = (y * size + x) * 4;
        image.data[offset] = level;
        image.data[offset + 1] = level;
        image.data[offset + 2] = level;
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return finish(canvas, { repeat: 1, srgb: false });
  });
}

/**
 * Normal map derived from a height field by central differences — cheaper and
 * sharper than shipping an image, and it stays in step with the colour map
 * because both come from the same noise.
 */
export function grainNormalTexture({ size = 512, strength = 1.4, scale = 60, seed = 11 } = {}) {
  return cached(`normal:${size}:${strength}:${scale}:${seed}`, () => {
    const noise = makeNoise(seed);
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] = fbm(noise, (x / size) * scale, (y / size) * scale, 4);
      }
    }
    const data = new Uint8Array(size * size * 4);
    const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        // Tangent-space normal: (-dx, -dy, 1), normalised then packed to 0..255.
        const length = Math.hypot(dx, dy, 1);
        const offset = (y * size + x) * 4;
        data[offset] = clamp255(((-dx / length) * 0.5 + 0.5) * 255);
        data[offset + 1] = clamp255(((-dy / length) * 0.5 + 0.5) * 255);
        data[offset + 2] = clamp255(((1 / length) * 0.5 + 0.5) * 255);
        data[offset + 3] = 255;
      }
    }
    const texture = new DataTexture(data, size, size, RGBAFormat);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
  });
}

/**
 * The soft round shadow blob under each piece. A real shadow map handles the
 * cast shadow; this is contact occlusion, which shadow maps at sane resolutions
 * always miss and whose absence makes pieces look like they are hovering.
 */
export function contactShadowTexture({ size = 128, softness = 2.4 } = {}) {
  return cached(`contact:${size}:${softness}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      gradient.addColorStop(t, `rgba(0,0,0,${(1 - t) ** softness * 0.55})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  });
}
