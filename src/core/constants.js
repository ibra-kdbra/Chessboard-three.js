/**
 * Board vocabulary shared by every layer. Pure data — no DOM, no three.js.
 */

export const FILES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
export const RANKS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8']);

/** All 64 squares in a1..h8 order. */
export const SQUARES = Object.freeze(
  RANKS.flatMap((rank) => FILES.map((file) => `${file}${rank}`)),
);

export const WHITE = 'w';
export const BLACK = 'b';

export const PAWN = 'p';
export const KNIGHT = 'n';
export const BISHOP = 'b';
export const ROOK = 'r';
export const QUEEN = 'q';
export const KING = 'k';

export const PIECE_TYPES = Object.freeze([PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING]);
export const PROMOTION_TYPES = Object.freeze([QUEEN, ROOK, BISHOP, KNIGHT]);

/** Classical centipawn-ish values, used for the captured-material tray only. */
export const PIECE_VALUES = Object.freeze({
  [PAWN]: 1,
  [KNIGHT]: 3,
  [BISHOP]: 3,
  [ROOK]: 5,
  [QUEEN]: 9,
  [KING]: 0,
});

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** `file` and `rank` as 0-based indices, a1 = (0, 0). */
export function squareToCoords(square) {
  const file = FILES.indexOf(square[0]);
  const rank = RANKS.indexOf(square[1]);
  if (file < 0 || rank < 0) throw new RangeError(`not a square: ${square}`);
  return { file, rank };
}

export function coordsToSquare(file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new RangeError(`off board: ${file},${rank}`);
  }
  return `${FILES[file]}${RANKS[rank]}`;
}

export function isSquare(value) {
  return typeof value === 'string' && /^[a-h][1-8]$/.test(value);
}

/** a1 is dark, so a square is light when file and rank indices differ in parity. */
export function isLightSquare(square) {
  const { file, rank } = squareToCoords(square);
  return (file + rank) % 2 === 1;
}

export const opposite = (color) => (color === WHITE ? BLACK : WHITE);
