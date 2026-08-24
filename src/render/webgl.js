/**
 * Whether this browser can give us a WebGL context.
 *
 * Deliberately outside the three.js tree: the app asks this to decide whether
 * to mount the 3D board at all, and answering it used to require loading the
 * renderer it is meant to guard.
 */
export function webGLEnabled() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
