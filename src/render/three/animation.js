/**
 * Motion.
 *
 * Every animation runs through one per-board ticker rather than its own timer,
 * so a board can be paused, disposed or resized without leaving stray callbacks
 * behind — the original leaked a shared, global, uncancellable tween list.
 *
 * The timings below are the difference between a board that feels responsive
 * and one that feels laggy: a move has to complete fast enough not to delay the
 * reply, while still reading as a physical action.
 */

/** Durations in ms. */
export const TIMING = Object.freeze({
  slide: 260,
  knightHop: 420,
  castleRookDelay: 90,
  capture: 240,
  promote: 520,
  snapback: 150,
  fade: 200,
  cameraFlip: 900,
  checkPulse: 700,
  highlightFade: 140,
});

/** Height a sliding piece lifts off the board, and the peak of a knight's arc. */
export const LIFT = Object.freeze({ slide: 0.22, knight: 2.1, drag: 1.6 });

export const easing = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeOutBack: (t) => {
    const c = 1.70158;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
  easeOutElastic: (t) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
  },
  /** Overshoot then settle — used for the promotion pop. */
  easeOutBackSoft: (t) => {
    const c = 1.1;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
};

/**
 * Drives every tween for one board.
 *
 * Tweens are advanced from a timestamp handed in by the render loop, not from
 * their own `performance.now()` calls, so a paused loop pauses the animation
 * instead of letting it silently run to completion in the background.
 */
export class Ticker {
  #tweens = new Set();
  #paused = false;
  /** Set when the user has asked for reduced motion; tweens then snap. */
  reducedMotion = false;

  get active() {
    return this.#tweens.size > 0;
  }

  get count() {
    return this.#tweens.size;
  }

  /**
   * @param {{ duration?: number, delay?: number, ease?: (t: number) => number,
   *           onUpdate: (t: number) => void, onComplete?: () => void }} spec
   * @returns {{ cancel: () => void, finished: Promise<void> }}
   */
  add({ duration = TIMING.slide, delay = 0, ease = easing.easeInOutCubic, onUpdate, onComplete }) {
    if (this.reducedMotion) {
      // Jump to the end state so the board still ends up correct.
      onUpdate?.(1);
      onComplete?.();
      return { cancel: () => {}, finished: Promise.resolve() };
    }

    let settle;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    const tween = {
      startedAt: null,
      duration: Math.max(1, duration),
      delay,
      ease,
      onUpdate,
      onComplete,
      settle,
      cancelled: false,
    };
    this.#tweens.add(tween);
    return {
      cancel: () => {
        tween.cancelled = true;
        this.#tweens.delete(tween);
        settle();
      },
      finished,
    };
  }

  /** Convenience: a tween that resolves when it finishes. */
  tween(spec) {
    return this.add(spec).finished;
  }

  /**
   * Advances every tween. Returns true when something changed, which the render
   * loop uses to decide whether it needs to draw at all.
   */
  update(now) {
    if (this.#paused || !this.#tweens.size) return false;
    let changed = false;
    for (const tween of [...this.#tweens]) {
      if (tween.cancelled) continue;
      if (tween.startedAt === null) tween.startedAt = now + tween.delay;
      if (now < tween.startedAt) {
        changed = true;
        continue;
      }
      const t = Math.min(1, (now - tween.startedAt) / tween.duration);
      tween.onUpdate?.(tween.ease(t), t);
      changed = true;
      if (t >= 1) {
        this.#tweens.delete(tween);
        tween.onComplete?.();
        tween.settle();
      }
    }
    return changed;
  }

  pause() {
    this.#paused = true;
  }

  resume(now) {
    if (!this.#paused) return;
    this.#paused = false;
    // Shift start times forward so a pause does not fast-forward the tweens.
    for (const tween of this.#tweens) {
      if (tween.startedAt !== null) tween.startedAt = now - (tween.elapsedAtPause ?? 0);
    }
  }

  /** Runs every pending tween to completion immediately. */
  finishAll() {
    for (const tween of [...this.#tweens]) {
      tween.onUpdate?.(1, 1);
      tween.onComplete?.();
      tween.settle();
    }
    this.#tweens.clear();
  }

  cancelAll() {
    for (const tween of [...this.#tweens]) {
      tween.cancelled = true;
      tween.settle();
    }
    this.#tweens.clear();
  }
}

/**
 * Position along a move.
 *
 * Knights hop, because a knight sliding through the pieces it jumps is the
 * single most common complaint about 3D chess boards. Everything else lifts
 * just enough to clear the board surface and to read as deliberate.
 *
 * @param {{x:number,z:number}} from
 * @param {{x:number,z:number}} to
 * @param {number} t eased progress, 0..1
 * @param {{ arc?: number }} [options]
 */
export function movePath(from, to, t, { arc = LIFT.slide } = {}) {
  return {
    x: from.x + (to.x - from.x) * t,
    z: from.z + (to.z - from.z) * t,
    // A parabola peaking at the midpoint; 4t(1-t) is 1 at t = 0.5.
    y: arc * 4 * t * (1 - t),
  };
}

/** Duration and arc for a move, chosen from the piece and the distance. */
export function movePlan(pieceCode, from, to) {
  const type = pieceCode[1]?.toUpperCase();
  if (type === 'N') {
    return { duration: TIMING.knightHop, arc: LIFT.knight, ease: easing.easeInOutQuad };
  }
  const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z)) / 2;
  // Longer moves take a little longer, but sub-linearly, so a rook crossing the
  // board does not feel sluggish next to a one-square king step.
  const duration = TIMING.slide * (0.75 + 0.14 * Math.sqrt(distance));
  return { duration, arc: LIFT.slide, ease: easing.easeInOutCubic };
}
