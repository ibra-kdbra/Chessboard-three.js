/**
 * Works out what moved between two positions.
 *
 * A renderer is handed positions, not moves — jumping to a saved game, undoing,
 * or loading a puzzle all change many squares at once. This turns any pair of
 * positions into a list of move/add/clear animations so those jumps glide
 * instead of teleporting.
 *
 * The algorithm is the one from chessboard.js (drop the squares that did not
 * change, then match each remaining destination to the nearest source holding
 * the same piece), with the per-call radius rebuild replaced by a table built
 * once at module load.
 */
import { FILES, RANKS, SQUARES } from './constants.js';

/** Chebyshev distance: a king's move count, which is the right notion of "near". */
export function squareDistance(a, b) {
  const fileDelta = Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0]));
  const rankDelta = Math.abs(RANKS.indexOf(a[1]) - RANKS.indexOf(b[1]));
  return Math.max(fileDelta, rankDelta);
}

/**
 * For every square, the other 63 ordered nearest-first. The original rebuilt
 * and re-sorted this on every lookup; there are only 64 of them and they never
 * change, so it is built once.
 */
const RADIUS = new Map(
  SQUARES.map((from) => [
    from,
    SQUARES.filter((to) => to !== from).sort(
      (a, b) => squareDistance(from, a) - squareDistance(from, b),
    ),
  ]),
);

export function radiusFrom(square) {
  return RADIUS.get(square) ?? [];
}

/** Nearest square to `square` holding `piece`, or null. */
export function findClosestPiece(position, piece, square) {
  for (const candidate of radiusFrom(square)) {
    if (position[candidate] === piece) return candidate;
  }
  return null;
}

/**
 * @typedef {{type: 'move', source: string, destination: string, piece: string}
 *          |{type: 'add', square: string, piece: string}
 *          |{type: 'clear', square: string, piece: string}} PositionAnimation
 */

/**
 * @param {Record<string,string>} oldPosition `{square: 'wP'}`
 * @param {Record<string,string>} newPosition
 * @returns {PositionAnimation[]}
 */
export function calculateAnimations(oldPosition, newPosition) {
  const from = { ...oldPosition };
  const to = { ...newPosition };

  // Squares that did not change take part in nothing.
  for (const square of Object.keys(to)) {
    if (from[square] === to[square]) {
      delete from[square];
      delete to[square];
    }
  }

  const animations = [];

  // Each destination claims the nearest matching piece still unspoken for.
  for (const square of Object.keys(to)) {
    const source = findClosestPiece(from, to[square], square);
    if (source) {
      animations.push({ type: 'move', source, destination: square, piece: to[square] });
      delete from[source];
      delete to[square];
    }
  }

  for (const [square, piece] of Object.entries(to)) {
    animations.push({ type: 'add', square, piece });
  }
  for (const [square, piece] of Object.entries(from)) {
    animations.push({ type: 'clear', square, piece });
  }

  return animations;
}

/** `'rnbq...'` FEN board field → `{square: 'wP'}`. Accepts a full FEN too. */
export function fenToPosition(fen) {
  const board = fen.trim().split(/\s+/)[0];
  const rows = board.split('/');
  if (rows.length !== 8) throw new Error(`bad FEN board field: ${board}`);
  const position = {};
  for (const [index, row] of rows.entries()) {
    const rank = RANKS[7 - index];
    let file = 0;
    for (const character of row) {
      if (/\d/.test(character)) {
        file += Number(character);
        continue;
      }
      if (file > 7) throw new Error(`too many squares in FEN rank: ${row}`);
      const color = character === character.toUpperCase() ? 'w' : 'b';
      position[`${FILES[file]}${rank}`] = `${color}${character.toUpperCase()}`;
      file++;
    }
  }
  return position;
}

/** Inverse of fenToPosition; emits only the board field. */
export function positionToFen(position) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (const file of FILES) {
      const piece = position[`${file}${rank}`];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      row += piece[0] === 'w' ? piece[1].toUpperCase() : piece[1].toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}
