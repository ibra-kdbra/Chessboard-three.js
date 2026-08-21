/**
 * A fast, engine-free position evaluator.
 *
 * Not a substitute for the real engine — it exists so the game can make cheap
 * judgements thousands of times per move without waiting on a worker: ranking
 * plausible-but-weak alternatives when a low-level opponent is told to err, and
 * spotting hanging pieces for the coaching overlay.
 *
 * Material plus piece-square tables, in centipawns, from White's point of view.
 */
import { Chess } from 'chess.js';

const MATERIAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Tables are written the way a board is drawn: index 0 is a8, index 63 is h1.
const PST = {
  p: [
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  kMiddle: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
  kEnd: [
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50,
  ],
};

/** Below this in non-pawn material per side, the king wants to be active. */
const ENDGAME_THRESHOLD = 1300;

/**
 * @param {Chess} chess a positioned chess.js instance
 * @returns {number} centipawns, positive favouring White
 */
export function evaluatePosition(chess) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -MATERIAL.k : MATERIAL.k;
  if (chess.isDraw() || chess.isStalemate()) return 0;

  const board = chess.board();
  let nonPawnMaterial = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell && cell.type !== 'p' && cell.type !== 'k') nonPawnMaterial += MATERIAL[cell.type];
    }
  }
  const endgame = nonPawnMaterial <= ENDGAME_THRESHOLD * 2;

  let score = 0;
  for (const [rankIndex, row] of board.entries()) {
    for (const [fileIndex, cell] of row.entries()) {
      if (!cell) continue;
      // board() yields rank 8 first, which is exactly the table's own layout.
      const whiteIndex = rankIndex * 8 + fileIndex;
      // Mirror vertically for Black so both sides read their own table.
      const index = cell.color === 'w' ? whiteIndex : (7 - rankIndex) * 8 + fileIndex;
      const table = cell.type === 'k' ? (endgame ? PST.kEnd : PST.kMiddle) : PST[cell.type];
      const value = MATERIAL[cell.type] + table[index];
      score += cell.color === 'w' ? value : -value;
    }
  }
  return score;
}

/** Evaluation from the side to move's point of view. */
export function evaluateForSideToMove(chess) {
  const score = evaluatePosition(chess);
  return chess.turn() === 'w' ? score : -score;
}

/**
 * Scores every legal move by the static evaluation of the resulting position,
 * from the mover's point of view. Sorted best first.
 * @returns {Array<{ move: object, score: number }>}
 */
export function scoreMoves(fen) {
  const chess = new Chess(fen);
  const mover = chess.turn();
  return chess
    .moves({ verbose: true })
    .map((move) => {
      const probe = new Chess(fen);
      probe.move(move.san);
      const score = evaluatePosition(probe) * (mover === 'w' ? 1 : -1);
      return { move, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pieces of `color` that an opponent can win material on: attacked and either
 * undefended, or defended only by something more valuable.
 *
 * This is the "you're about to lose that knight" hint, so it deliberately errs
 * towards reporting only clear cases rather than every loose piece.
 * @returns {Array<{ square: string, type: string, attackers: string[], defenders: string[], loss: number }>}
 */
export function findHangingPieces(fen, color) {
  const chess = new Chess(fen);
  const opponent = color === 'w' ? 'b' : 'w';
  const hanging = [];

  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === 'k') continue;
      const attackers = chess.attackers(cell.square, opponent);
      if (!attackers.length) continue;
      const defenders = chess.attackers(cell.square, color);

      const cheapestAttacker = Math.min(
        ...attackers.map((square) => MATERIAL[chess.get(square).type]),
      );
      const value = MATERIAL[cell.type];
      // Undefended, or worth clearly more than the cheapest thing hitting it.
      const loss = defenders.length === 0 ? value : value - cheapestAttacker;
      if (defenders.length === 0 || loss > 50) {
        hanging.push({ square: cell.square, type: cell.type, attackers, defenders, loss });
      }
    }
  }
  return hanging.sort((a, b) => b.loss - a.loss);
}
