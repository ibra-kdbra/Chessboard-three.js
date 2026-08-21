/**
 * Turning raw engine numbers into things a human can act on.
 *
 * Centipawns are a terrible scale to reason with: +100 in a balanced middlegame
 * is a real edge, +100 when you are already up a queen is noise. Everything
 * here therefore converts to expected score first, and judges move quality by
 * how much expected score was thrown away, which is what makes a "blunder"
 * label match a player's intuition.
 */

/** Anything beyond this is displayed as a clean win rather than a number. */
export const MATE_SCORE = 100_000;

/**
 * Logistic centipawn → expected score, from the side to move's point of view.
 * The 1/400 slope is the long-standing Elo-derived fit; `k` reproduces the
 * commonly used "+300cp ≈ 85%" calibration.
 */
export function winningChances(cp, k = 0.00368208) {
  return 2 / (1 + Math.exp(-k * cp)) - 1;
}

/** Expected score in 0..1 (0.5 = dead equal). */
export function expectedScore(evaluation) {
  if (!evaluation) return 0.5;
  if (evaluation.type === 'mate') return evaluation.value > 0 ? 1 : 0;
  return (winningChances(evaluation.value) + 1) / 2;
}

/** Flips an evaluation from side-to-move-relative to white-relative. */
export function toWhitePov(evaluation, turn) {
  if (!evaluation) return null;
  const sign = turn === 'w' ? 1 : -1;
  return { ...evaluation, value: evaluation.value * sign };
}

/** `+1.24`, `-0.30`, `M4`, `-M2`. */
export function formatEvaluation(evaluation, { alwaysSign = true } = {}) {
  if (!evaluation) return '—';
  if (evaluation.type === 'mate') {
    const n = Math.abs(evaluation.value);
    return `${evaluation.value < 0 ? '-' : ''}M${n}`;
  }
  const pawns = evaluation.value / 100;
  const text = Math.abs(pawns) >= 10 ? pawns.toFixed(1) : pawns.toFixed(2);
  return alwaysSign && pawns >= 0 ? `+${text}` : text;
}

/**
 * Where the eval bar's divider sits, 0 (black winning) to 1 (white winning).
 * Clamped well short of the ends so a decisive-but-not-mate position still
 * shows a sliver of the losing colour.
 */
export function evaluationToBar(evaluationWhitePov) {
  if (!evaluationWhitePov) return 0.5;
  if (evaluationWhitePov.type === 'mate') {
    return evaluationWhitePov.value > 0 ? 1 : 0;
  }
  const clamped = Math.max(-1000, Math.min(1000, evaluationWhitePov.value));
  return Math.max(0.02, Math.min(0.98, (winningChances(clamped) + 1) / 2));
}

/**
 * Move-quality thresholds, in lost expected score (0..1).
 * Tuned so a "blunder" is roughly "gave away a piece or the game".
 */
export const QUALITY_THRESHOLDS = Object.freeze({
  blunder: 0.2,
  mistake: 0.1,
  inaccuracy: 0.05,
});

export const QUALITY_META = Object.freeze({
  brilliant: { symbol: '!!', label: 'Brilliant', nag: 3, tone: 'brilliant' },
  best: { symbol: '★', label: 'Best move', nag: null, tone: 'best' },
  excellent: { symbol: '', label: 'Excellent', nag: null, tone: 'good' },
  good: { symbol: '', label: 'Good', nag: null, tone: 'good' },
  book: { symbol: '', label: 'Book', nag: null, tone: 'book' },
  inaccuracy: { symbol: '?!', label: 'Inaccuracy', nag: 6, tone: 'inaccuracy' },
  mistake: { symbol: '?', label: 'Mistake', nag: 2, tone: 'mistake' },
  blunder: { symbol: '??', label: 'Blunder', nag: 4, tone: 'blunder' },
});

/**
 * Classifies a move by comparing the position before and after, both scored
 * from the mover's point of view.
 *
 * @param {{type:'cp'|'mate', value:number}} before eval of the position the mover faced
 * @param {{type:'cp'|'mate', value:number}} after eval after the move, already flipped to the mover
 * @param {{ wasBest?: boolean, isBook?: boolean, isOnlyMove?: boolean, sacrifice?: boolean }} [context]
 * @returns {keyof QUALITY_META}
 */
export function classifyMove(before, after, context = {}) {
  if (context.isBook) return 'book';
  const lost = Math.max(0, expectedScore(before) - expectedScore(after));

  if (context.wasBest) {
    // A best move that also gives material away is the interesting case.
    if (context.sacrifice && lost < QUALITY_THRESHOLDS.inaccuracy) return 'brilliant';
    return 'best';
  }
  if (lost >= QUALITY_THRESHOLDS.blunder) return 'blunder';
  if (lost >= QUALITY_THRESHOLDS.mistake) return 'mistake';
  if (lost >= QUALITY_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (lost <= 0.02) return 'excellent';
  return 'good';
}

/**
 * Accuracy on the 0-100 scale players expect, from the per-move expected-score
 * losses of one side. Uses the exponential fit popularised by lichess.
 */
export function accuracyFromLosses(losses) {
  if (!losses.length) return 100;
  const perMove = losses.map((lost) => {
    const dropInWinPercent = lost * 100;
    const raw = 103.1668 * Math.exp(-0.04354 * dropInWinPercent) - 3.1669;
    return Math.max(0, Math.min(100, raw));
  });
  const mean = perMove.reduce((sum, value) => sum + value, 0) / perMove.length;
  return Math.round(mean * 10) / 10;
}

/**
 * Walks a finished game's mainline and annotates every node with a quality
 * label, then reports per-side totals. Requires each node to already carry an
 * `evaluation` (white-relative) — that is the analysis pass's job.
 *
 * @param {import('./gameTree.js').GameTree} tree
 * @returns {{ w: object, b: object }} per-side counts and accuracy
 */
export function reviewGame(tree, { bookPlies = 0 } = {}) {
  const nodes = tree.mainline();
  const losses = { w: [], b: [] };
  const counts = {
    w: {
      brilliant: 0,
      best: 0,
      excellent: 0,
      good: 0,
      book: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    },
    b: {
      brilliant: 0,
      best: 0,
      excellent: 0,
      good: 0,
      book: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    },
  };

  for (const [index, node] of nodes.entries()) {
    const previousEval = index === 0 ? tree.root.evaluation : nodes[index - 1].evaluation;
    if (!previousEval || !node.evaluation) continue;

    const mover = node.color;
    const sign = mover === 'w' ? 1 : -1;
    const before = { ...previousEval, value: previousEval.value * sign };
    const after = { ...node.evaluation, value: node.evaluation.value * sign };

    const quality = classifyMove(before, after, {
      isBook: index < bookPlies,
      wasBest: node.wasBest === true,
      sacrifice: node.move?.captured === undefined && node.sacrifice === true,
    });
    node.quality = quality;
    counts[mover][quality]++;
    if (quality !== 'book') {
      losses[mover].push(Math.max(0, expectedScore(before) - expectedScore(after)));
    }
  }

  const graded = losses.w.length + losses.b.length + counts.w.book + counts.b.book;
  return {
    w: { ...counts.w, accuracy: accuracyFromLosses(losses.w), moves: losses.w.length },
    b: { ...counts.b, accuracy: accuracyFromLosses(losses.b), moves: losses.b.length },
    /**
     * Share of the mainline that actually carried a score, 0..1.
     *
     * A game played against the engine only has evaluations on the plies the
     * engine itself searched, so grading it without a full analysis pass
     * silently reports perfect accuracy for both sides. Callers should refuse
     * to show an accuracy figure below a high coverage.
     */
    coverage: nodes.length ? graded / nodes.length : 0,
    plies: nodes.length,
  };
}
