/**
 * The contract both renderers implement.
 *
 * The 2D/3D switch is a straight swap, so neither renderer may expose anything
 * the other cannot. Anything genuinely 3D-only (camera modes, quality tiers)
 * lives behind `capabilities` and is feature-detected by the caller rather than
 * type-sniffed.
 *
 * Events, via Emitter: `move` ({from, to}), `select` (square|null),
 * `hover` (square|null), `arrow` ({from, to}), `ready`.
 */

/**
 * @typedef {object} BoardRenderer
 * @property {(position: string|Record<string,string>, options?: {animate?: boolean}) => Promise<void>} setPosition
 * @property {() => Record<string,string>} getPosition
 * @property {(value?: 'white'|'black'|'flip') => 'white'|'black'} orientation
 * @property {(state: object) => void} setHighlights
 * @property {(arrows: object[]) => void} setArrows
 * @property {(theme: object) => void} setTheme
 * @property {(set: string) => Promise<void>} setPieceSet
 * @property {(enabled: boolean) => void} setInteractive
 * @property {(enabled: boolean) => void} setShowNotation
 * @property {(enabled: boolean) => void} setReducedMotion
 * @property {() => void} resize
 * @property {() => void} destroy
 * @property {object} capabilities
 */

export const RENDERER_METHODS = Object.freeze([
  'setPosition',
  'getPosition',
  'orientation',
  'setHighlights',
  'setArrows',
  'setTheme',
  'setPieceSet',
  'setInteractive',
  'setShowNotation',
  'setReducedMotion',
  'resize',
  'destroy',
]);

/** Throws if `renderer` is missing part of the contract. Used by the tests. */
export function assertRendererContract(renderer, label = 'renderer') {
  const missing = RENDERER_METHODS.filter((name) => typeof renderer[name] !== 'function');
  if (missing.length) {
    throw new Error(`${label} does not implement BoardRenderer: missing ${missing.join(', ')}`);
  }
  if (typeof renderer.capabilities !== 'object') {
    throw new Error(`${label} does not expose capabilities`);
  }
  return true;
}
