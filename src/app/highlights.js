/**
 * What the board should be showing right now.
 *
 * This is the one place that decides which squares are marked, and it is pure:
 * given a session and the app's transient selection, it returns a plain object
 * that either renderer can draw. Keeping it out of the bootstrap closure is
 * what makes it testable — the shape it returns is the contract between the
 * app and both boards, and it used to be reachable only by starting a browser,
 * a WebGL context and two workers.
 */
import { findHangingPieces } from '../core/staticEval.js';

/** A piece worth this much or more, hanging, is worth pointing at. */
const COACH_LOSS_THRESHOLD = 100;

/** At most this many, so the overlay stays a hint rather than a heat map. */
const COACH_LIMIT = 3;

/**
 * @param {object} context
 * @param {object} context.session the live Session
 * @param {object} context.settings the app's settings object
 * @param {string|null} [context.selected] the square the player has picked up
 * @param {string|null} [context.cursorSquare] the keyboard cursor
 * @param {{from: string, to: string}|null} [context.hintMove] the engine's suggestion
 * @returns {object} highlight state for `renderer.setHighlights`
 */
export function highlightState({
  session,
  settings,
  selected = null,
  cursorSquare = null,
  hintMove = null,
}) {
  const status = session.status();
  const last = session.state.node.move;

  return {
    threatened: coachSquares(session, settings, status),
    // The keyboard cursor lives here so an unrelated refresh — a hint landing,
    // a coach update — does not wipe the square the user is standing on.
    hover: cursorSquare,
    lastMove: last ? { from: last.from, to: last.to } : null,
    check: status.check ? session.kingSquare(status.turn) : null,
    hint: hintMove ? { from: hintMove.from, to: hintMove.to } : null,
    selected,
    legal:
      selected && settings.showLegalMoves
        ? session.state.legalMoves(selected).map((move) => ({
            to: move.to,
            capture: Boolean(move.captured),
          }))
        : [],
  };
}

/**
 * The coach layer: pieces of the side to move that can simply be taken.
 *
 * Deliberately only the clear cases. An overlay that lights up half the board
 * every move is noise, and players stop reading it.
 */
function coachSquares(session, settings, status) {
  if (!settings.coachHints || status.result.over) return [];
  return findHangingPieces(session.state.fen, status.turn)
    .filter((entry) => entry.loss >= COACH_LOSS_THRESHOLD)
    .slice(0, COACH_LIMIT)
    .map((entry) => entry.square);
}
