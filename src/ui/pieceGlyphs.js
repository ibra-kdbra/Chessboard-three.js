/**
 * Piece glyphs for the 2D chrome — captured tray, promotion picker, move list.
 *
 * Unicode chess characters rather than SVG paths or the PNG sets already in the
 * repository: they inherit the text colour so they theme for free, stay crisp
 * at any size, and cost nothing to download. The font stack lists the faces
 * known to carry the block, since not every system font does.
 */

export const GLYPH_FONT_STACK =
  '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", "DejaVu Sans", "Arial Unicode MS", sans-serif';

const WHITE = { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' };
const BLACK = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/** @param {'w'|'b'} color @param {string} type one of k q r b n p */
export function pieceGlyph(color, type) {
  const table = color === 'w' ? WHITE : BLACK;
  return table[type.toLowerCase()] ?? '';
}

export const PIECE_NAMES = Object.freeze({
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
});

/**
 * How a move should be read aloud. Screen readers announce "Nf3" as "enn eff
 * three", which is useless to someone who cannot see the board.
 * @param {object} move a verbose move object
 */
export function describeMove(move, { check = false, checkmate = false } = {}) {
  if (!move) return '';
  const piece = PIECE_NAMES[move.piece] ?? 'piece';
  const parts = [];

  if (move.flags?.includes('k')) parts.push('castles kingside');
  else if (move.flags?.includes('q')) parts.push('castles queenside');
  else {
    parts.push(`${piece} ${move.from} to ${move.to}`);
    if (move.captured) parts.push(`takes ${PIECE_NAMES[move.captured] ?? 'piece'}`);
    if (move.flags?.includes('e')) parts.push('en passant');
    if (move.promotion) parts.push(`promotes to ${PIECE_NAMES[move.promotion]}`);
  }
  if (checkmate) parts.push('checkmate');
  else if (check) parts.push('check');
  return parts.join(', ');
}
