/**
 * Camera geometry and the presets built on it, as data.
 *
 * A leaf module on purpose: the settings dialog lists the presets, and reaching
 * them through board3d.js pulled the whole three.js runtime — a megabyte across
 * 29 requests — into a page that might never draw in 3D. Nothing here imports
 * anything, so scene.js and board3d.js take these values from here and
 * re-export them; there is one definition, not a copy that can drift.
 */

/** How far the camera sits from the board's centre. */
export const CAMERA_DISTANCE = 26;

/** Resting polar angle of the orbit camera, in radians. */
export const CAMERA_POLAR_ANGLE = Math.PI / 4.4;

export const CAMERA_MODES = Object.freeze({
  orbit: { id: 'orbit', name: 'Orbit', polar: CAMERA_POLAR_ANGLE, zoom: 1 },
  top: { id: 'top', name: 'Top down', polar: 0.04, zoom: 0.94 },
  low: { id: 'low', name: "Player's eye", polar: Math.PI / 2.5, zoom: 1.06 },
  cinematic: { id: 'cinematic', name: 'Cinematic', polar: Math.PI / 3.4, zoom: 0.98, drift: true },
});
