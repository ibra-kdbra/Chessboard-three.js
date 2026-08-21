/**
 * Builds three.js materials from the plain-data surface descriptions in
 * themes.js.
 *
 * Everything is MeshPhysicalMaterial: the extra cost over MeshStandardMaterial
 * buys clearcoat and transmission, which are what make lacquered wood look
 * lacquered and glass pieces look like glass rather than tinted plastic.
 */
import { Color, DoubleSide, MeshPhysicalMaterial, MeshBasicMaterial, SRGBColorSpace } from 'three';
import { woodTexture, marbleTexture, roughnessTexture, grainNormalTexture } from './textures.js';

/**
 * @param {object} surface a theme surface description
 * @param {{ textureScale?: number, quality?: 'low'|'medium'|'high'|'ultra' }} [options]
 * @returns {MeshPhysicalMaterial}
 */
export function buildMaterial(surface, { textureScale = 1, quality = 'high' } = {}) {
  const detailed = quality !== 'low';
  const size = quality === 'ultra' ? 1024 : quality === 'high' ? 768 : 512;

  const params = {
    color: new Color(surface.color ?? 0xffffff),
    roughness: surface.roughness ?? 0.5,
    metalness: surface.metalness ?? 0,
    clearcoat: surface.clearcoat ?? 0,
    clearcoatRoughness: surface.clearcoatRoughness ?? 0.2,
    envMapIntensity: surface.envMapIntensity ?? 1,
  };

  if (surface.emissive) {
    params.emissive = new Color(surface.emissive);
    params.emissiveIntensity = surface.emissiveIntensity ?? 0.5;
  }
  if (surface.transmission) {
    params.transmission = surface.transmission;
    params.ior = surface.ior ?? 1.5;
    params.thickness = surface.thickness ?? 1;
    // Transmission needs both sides or the interior reads as a hole.
    params.side = DoubleSide;
    params.transparent = true;
  }
  if (surface.sheen) {
    params.sheen = surface.sheen;
    params.sheenColor = new Color(surface.sheenColor ?? surface.color ?? 0xffffff);
  }

  const material = new MeshPhysicalMaterial(params);
  if (!detailed) return material;

  switch (surface.kind) {
    case 'wood': {
      material.map = woodTexture({
        size,
        light: surface.light ?? 0xc8a06a,
        dark: surface.dark ?? 0x6b4526,
        rings: surface.rings ?? 12,
        turbulence: surface.turbulence ?? 5.5,
        seed: surface.seed ?? 7,
        angle: surface.angle ?? 0,
      });
      material.roughnessMap = roughnessTexture({
        base: material.roughness,
        spread: 0.1,
        scale: 40,
        seed: 5,
      });
      material.normalMap = grainNormalTexture({ strength: 0.45, scale: 26, seed: 13 });
      material.normalScale.set(0.12, 0.12);
      break;
    }
    case 'marble': {
      material.map = marbleTexture({
        size,
        base: surface.base ?? 0xf2efe6,
        vein: surface.vein ?? 0x9a9384,
        scale: surface.scale ?? 3.2,
        turbulence: surface.turbulence ?? 6,
        seed: surface.seed ?? 21,
      });
      material.roughnessMap = roughnessTexture({
        base: material.roughness,
        spread: 0.07,
        scale: 30,
        seed: 17,
      });
      material.normalMap = grainNormalTexture({ strength: 0.2, scale: 18, seed: 23 });
      material.normalScale.set(0.07, 0.07);
      break;
    }
    case 'metal': {
      material.metalness = surface.metalness ?? 0.9;
      // Brushed, not mirror: a little anisotropic grain reads as machined.
      material.roughnessMap = roughnessTexture({
        base: material.roughness,
        spread: 0.22,
        scale: 240,
        seed: 31,
      });
      material.normalMap = grainNormalTexture({ strength: 0.5, scale: 200, seed: 29 });
      material.normalScale.set(0.2, 0.05);
      break;
    }
    case 'stone': {
      material.roughnessMap = roughnessTexture({
        base: material.roughness,
        spread: 0.3,
        scale: 60,
        seed: 37,
      });
      material.normalMap = grainNormalTexture({ strength: 0.7, scale: 28, seed: 41 });
      material.normalScale.set(0.22, 0.22);
      break;
    }
    default:
      break;
  }

  for (const map of [material.map, material.roughnessMap, material.normalMap]) {
    if (map) map.repeat.set(textureScale, textureScale);
  }
  if (material.map) {
    material.map.colorSpace = SRGBColorSpace;
    // three multiplies map by color. The generated maps already carry the
    // theme's palette, so leaving `color` set applies it a second time and the
    // surface comes out roughly twice as dark as the theme asked for.
    material.color.set(surface.tint ?? 0xffffff);
  }

  return material;
}

/** Flat unlit material for highlight decals and overlays. */
export function buildOverlayMaterial(color, opacity = 0.55) {
  const material = new MeshBasicMaterial({
    color: new Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
  });
  // Sit just above the board surface without z-fighting.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  return material;
}

/** Frees a material and every texture it owns. */
export function disposeMaterial(material) {
  if (!material) return;
  for (const key of ['map', 'roughnessMap', 'normalMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
    // Textures are cached and shared between themes, so they are disposed by
    // disposeTextureCache() rather than here.
    if (material[key]) material[key] = null;
  }
  material.dispose();
}
