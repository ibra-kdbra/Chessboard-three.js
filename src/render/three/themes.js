/**
 * Board themes.
 *
 * A theme is a complete look: square and frame surfaces, both piece materials,
 * the environment the scene is lit by, the highlight palette, and how much
 * post-processing the look wants. Materials are described as plain data and
 * built by materials.js, so a theme can be swapped without rebuilding the scene.
 *
 * Highlight colours are chosen to stay distinguishable under deuteranopia and
 * protanopia: the four cues differ in lightness as well as hue, and never rely
 * on a red/green pair to carry meaning.
 */

/** @typedef {'wood'|'marble'|'metal'|'glass'|'plain'|'stone'} SurfaceKind */

const HIGHLIGHTS_DEFAULT = {
  selected: 0x3aa7ff,
  legal: 0x35d29a,
  legalCapture: 0xff7a45,
  lastMove: 0xf5c451,
  check: 0xff3b5c,
  hover: 0xffffff,
  premove: 0xa06bff,
  hint: 0x7c5cff,
};

export const THEMES = Object.freeze({
  tournament: {
    id: 'tournament',
    name: 'Tournament',
    blurb: 'Boxwood and walnut, the set on every club table.',
    background: 0x1b1f27,
    fog: { color: 0x1b1f27, near: 34, far: 78 },
    environment: { kind: 'room', intensity: 0.55 },
    board: {
      light: { kind: 'wood', color: 0xd9b98a, light: 0xe4c99f, dark: 0xa87c4c, rings: 11, roughness: 0.44, clearcoat: 0.28 },
      dark: { kind: 'wood', color: 0x63422a, light: 0x7d5636, dark: 0x3c2415, rings: 9, roughness: 0.46, clearcoat: 0.26 },
      frame: { kind: 'wood', color: 0x4a2f1c, light: 0x5d3c23, dark: 0x2a1810, rings: 6, roughness: 0.38, clearcoat: 0.4 },
      inlay: 0xd8c49a,
    },
    pieces: {
      white: { kind: 'wood', color: 0xf0e2c8, light: 0xf6ead4, dark: 0xd8bf94, rings: 26, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 },
      black: { kind: 'wood', color: 0x2f2119, light: 0x402d21, dark: 0x160f0a, rings: 24, roughness: 0.4, clearcoat: 0.38, clearcoatRoughness: 0.28 },
    },
    highlights: HIGHLIGHTS_DEFAULT,
    post: { bloom: 0.12, bloomThreshold: 0.85, ssao: true },
  },

  marble: {
    id: 'marble',
    name: 'Marble Hall',
    blurb: 'Polished stone under a gallery skylight.',
    background: 0x20242c,
    fog: { color: 0x20242c, near: 36, far: 84 },
    environment: { kind: 'room', intensity: 0.9 },
    board: {
      light: { kind: 'marble', color: 0xece8de, base: 0xf3efe6, vein: 0xb9b2a2, roughness: 0.16, clearcoat: 0.7, clearcoatRoughness: 0.08 },
      dark: { kind: 'marble', color: 0x3a3d45, base: 0x40444c, vein: 0x22252b, roughness: 0.18, clearcoat: 0.7, clearcoatRoughness: 0.1 },
      frame: { kind: 'metal', color: 0x9a9483, roughness: 0.3, metalness: 0.85 },
      inlay: 0xb9a97e,
    },
    pieces: {
      white: { kind: 'marble', color: 0xf5f2ea, base: 0xf8f6f0, vein: 0xcfc9ba, roughness: 0.14, clearcoat: 0.85, clearcoatRoughness: 0.06 },
      black: { kind: 'marble', color: 0x2b2e35, base: 0x33363d, vein: 0x15171b, roughness: 0.15, clearcoat: 0.85, clearcoatRoughness: 0.07 },
    },
    highlights: HIGHLIGHTS_DEFAULT,
    post: { bloom: 0.18, bloomThreshold: 0.8, ssao: true },
  },

  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    blurb: 'Black glass and cold light.',
    background: 0x07090d,
    fog: { color: 0x07090d, near: 28, far: 70 },
    environment: { kind: 'room', intensity: 0.4 },
    board: {
      light: { kind: 'stone', color: 0x40474f, roughness: 0.28, metalness: 0.15, clearcoat: 0.6 },
      dark: { kind: 'stone', color: 0x14181d, roughness: 0.3, metalness: 0.18, clearcoat: 0.6 },
      frame: { kind: 'metal', color: 0x2a2f36, roughness: 0.22, metalness: 0.95 },
      inlay: 0x4fd6ff,
    },
    pieces: {
      white: { kind: 'glass', color: 0xdff2ff, roughness: 0.06, metalness: 0, transmission: 0.55, ior: 1.7, thickness: 1.4, clearcoat: 1, emissive: 0x0a2233, emissiveIntensity: 0.25 },
      black: { kind: 'glass', color: 0x121a22, roughness: 0.07, metalness: 0.1, transmission: 0.25, ior: 1.8, thickness: 1.6, clearcoat: 1, emissive: 0x001018, emissiveIntensity: 0.3 },
    },
    highlights: { ...HIGHLIGHTS_DEFAULT, selected: 0x4fd6ff, legal: 0x49f5c4, hover: 0xd7f6ff },
    post: { bloom: 0.55, bloomThreshold: 0.62, ssao: true },
  },

  emerald: {
    id: 'emerald',
    name: 'Emerald Club',
    blurb: 'The green vinyl roll-up, done properly.',
    background: 0x161d1a,
    fog: { color: 0x161d1a, near: 34, far: 80 },
    environment: { kind: 'room', intensity: 0.6 },
    board: {
      light: { kind: 'plain', color: 0xeae3d2, roughness: 0.62, clearcoat: 0.1 },
      dark: { kind: 'plain', color: 0x4a7a5c, roughness: 0.64, clearcoat: 0.1 },
      frame: { kind: 'wood', color: 0x2f3a33, light: 0x3c4b41, dark: 0x1d2621, rings: 7, roughness: 0.5 },
      inlay: 0xe0d7c0,
    },
    pieces: {
      white: { kind: 'plain', color: 0xf2ece0, roughness: 0.48, clearcoat: 0.3, clearcoatRoughness: 0.35 },
      black: { kind: 'plain', color: 0x232a26, roughness: 0.46, clearcoat: 0.32, clearcoatRoughness: 0.33 },
    },
    highlights: HIGHLIGHTS_DEFAULT,
    post: { bloom: 0.1, bloomThreshold: 0.9, ssao: true },
  },

  neon: {
    id: 'neon',
    name: 'Neon Grid',
    blurb: 'Chess at 3am on a CRT.',
    background: 0x05030f,
    fog: { color: 0x0a0620, near: 24, far: 66 },
    environment: { kind: 'room', intensity: 0.25 },
    board: {
      light: { kind: 'plain', color: 0x1d1440, roughness: 0.32, metalness: 0.4, emissive: 0x2a1a66, emissiveIntensity: 0.35 },
      dark: { kind: 'plain', color: 0x0d0824, roughness: 0.34, metalness: 0.45, emissive: 0x140d3a, emissiveIntensity: 0.3 },
      frame: { kind: 'metal', color: 0x1a1140, roughness: 0.18, metalness: 1, emissive: 0xff2fb0, emissiveIntensity: 0.18 },
      inlay: 0x00e5ff,
    },
    pieces: {
      white: { kind: 'plain', color: 0x9ef7ff, roughness: 0.22, metalness: 0.5, emissive: 0x00c8ff, emissiveIntensity: 0.85, clearcoat: 1 },
      black: { kind: 'plain', color: 0xff77d4, roughness: 0.24, metalness: 0.55, emissive: 0xff1e9b, emissiveIntensity: 0.8, clearcoat: 1 },
    },
    highlights: { ...HIGHLIGHTS_DEFAULT, selected: 0x00e5ff, legal: 0x7cff6b, lastMove: 0xffe14f, check: 0xff2f5e },
    post: { bloom: 1.15, bloomThreshold: 0.42, ssao: false },
  },

  ivory: {
    id: 'ivory',
    name: 'Ivory & Ebony',
    blurb: 'A warm study, lamp on the left.',
    background: 0x2a2119,
    fog: { color: 0x2a2119, near: 34, far: 80 },
    environment: { kind: 'room', intensity: 0.7 },
    board: {
      light: { kind: 'marble', color: 0xefe4cd, base: 0xf4ead6, vein: 0xd2c1a0, roughness: 0.22, clearcoat: 0.6 },
      dark: { kind: 'wood', color: 0x2b1d16, light: 0x3b2a1f, dark: 0x150d09, rings: 10, roughness: 0.3, clearcoat: 0.55 },
      frame: { kind: 'wood', color: 0x6b4a2c, light: 0x855c37, dark: 0x3f2a18, rings: 8, roughness: 0.34, clearcoat: 0.5 },
      inlay: 0xe8d3a8,
    },
    pieces: {
      white: { kind: 'marble', color: 0xf7efdc, base: 0xfaf4e6, vein: 0xdcc9a4, roughness: 0.2, clearcoat: 0.75, clearcoatRoughness: 0.14 },
      black: { kind: 'wood', color: 0x1e1410, light: 0x2c1e17, dark: 0x0d0806, rings: 30, roughness: 0.24, clearcoat: 0.7, clearcoatRoughness: 0.16 },
    },
    highlights: HIGHLIGHTS_DEFAULT,
    post: { bloom: 0.2, bloomThreshold: 0.82, ssao: true },
  },
});

export const THEME_IDS = Object.freeze(Object.keys(THEMES));
export const DEFAULT_THEME = 'tournament';

export function getTheme(id) {
  return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

/**
 * High-contrast highlight overrides, for players who need the cues to carry
 * without relying on the theme's own palette.
 */
export const ACCESSIBLE_HIGHLIGHTS = Object.freeze({
  selected: 0x00b0ff,
  legal: 0x00e676,
  legalCapture: 0xff6d00,
  lastMove: 0xffea00,
  check: 0xff1744,
  hover: 0xffffff,
  premove: 0xd500f9,
  hint: 0x651fff,
});
