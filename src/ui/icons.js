/**
 * The icon set.
 *
 * Every icon is authored on the same 24x24 grid with a 2px round-capped stroke
 * and no fill, so they sit together at any size and inherit colour from the
 * button they live in. This replaces the Unicode glyphs the controls used to
 * borrow: those were text, not icons, and the font fallback chain decided what
 * each one looked like — measured across the old rail, the ten "icons" varied
 * 2.5x in advance width and 5.5x in optical weight, and three of them came from
 * a different typeface than the rest.
 *
 * Keep the grid, the stroke and the optical weight consistent when adding one.
 */

/** Shared attributes. `stroke-width` stays 2 so weights never drift apart. */
const ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Path geometry only — the wrapper supplies everything else. */
const PATHS = {
  // ---- move navigation, drawn as media transport so the group reads at a glance
  // Chevron-and-bar rather than the usual filled triangles: the rest of the set
  // is stroke-only, and an outlined triangle beside a stroked chevron reads as
  // two different weights.
  first: '<path d="M7 5v14"/><path d="M19 6l-7 6 7 6"/>',
  previous: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  last: '<path d="M17 5v14"/><path d="M5 6l7 6-7 6"/>',

  // ---- board view
  flip:
    '<path d="M8 3 4 7l4 4"/><path d="M4 7h11a5 5 0 0 1 5 5"/>' +
    '<path d="m16 21 4-4-4-4"/><path d="M20 17H9a5 5 0 0 1-5-5"/>',

  // ---- assistance
  hint:
    '<path d="M9 18h6"/><path d="M10 22h4"/>' +
    '<path d="M15.1 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.4-2 1.4-3.5a6 6 0 0 0-12 0c0 1.5.5 2.6 1.4 3.5.8.8 1.3 1.5 1.5 2.5"/>',
  takeback: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',

  // ---- game actions
  draw: '<path d="M12 5v14"/><path d="M5 9h14"/><path d="M5 15h14"/>',
  resign:
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V4"/>',
  newGame: '<path d="M12 5v14"/><path d="M5 12h14"/>',

  // ---- library and transfer
  library:
    '<path d="M4 20V6a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>' +
    '<path d="M14 4v5h5"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  export: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 21h16"/>',
  share:
    '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>' +
    '<path d="M12 3v13"/><path d="m8 7 4-4 4 4"/>',

  // ---- app chrome
  settings:
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 2h0l1.2 2.6 2.8-.6.6 2.8L19.4 8l-1.4 2.5 2 2-2 2 1.4 2.5-2.8 1.2-.6 2.8-2.8-.6L12 22l-1.2-2.6-2.8.6-.6-2.8L4.6 16 6 13.5l-2-2 2-2L4.6 7l2.8-1.2.6-2.8 2.8.6z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  help:
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
};

/**
 * Returns the markup for an icon.
 *
 * @param {keyof PATHS} name
 * @param {number} [size] pixel size of the square box
 * @returns {string} an `<svg>` string, ready for `innerHTML`
 */
export function iconMarkup(name, size = 20) {
  const paths = PATHS[name];
  if (!paths) throw new Error(`icon: no such icon "${name}"`);
  return `<svg class="icon" width="${size}" height="${size}" ${ATTRS}>${paths}</svg>`;
}

/**
 * Builds an icon element.
 *
 * @param {keyof PATHS} name
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function icon(name, size = 20) {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = iconMarkup(name, size);
  return wrapper.firstElementChild;
}

/** Every icon this set defines, for tests that assert the set stays coherent. */
export const ICON_NAMES = Object.keys(PATHS);
