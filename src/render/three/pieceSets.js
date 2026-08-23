/**
 * The 3D piece-set catalogue, as data.
 *
 * A leaf module for the same reason as cameraModes.js: the settings dialog
 * lists these, and reaching them through pieces.js dragged three.js in with
 * them. pieces.js re-exports it.
 */
export const PIECE_SETS = Object.freeze({
  classic: { id: 'classic', name: 'Classic', blurb: 'Staunton, turned and weighted.' },
  iconic: { id: 'iconic', name: 'Iconic', blurb: 'Flat, graphic, unmistakable.' },
  minions: { id: 'minions', name: 'Minions', blurb: 'Small people who take chess seriously.' },
});
