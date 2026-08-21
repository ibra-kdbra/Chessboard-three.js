/**
 * Chess clock with Fischer and Bronstein increments.
 *
 * Time is read from an injected `now()` rather than Date.now() so tests can
 * drive it deterministically, and so a paused tab does not silently drift: the
 * remaining time is always recomputed from a timestamp, never decremented by a
 * timer tick.
 */
import { Emitter } from './emitter.js';
import { WHITE, BLACK } from './constants.js';

/** Ready-made controls, in the order a picker should show them. */
export const TIME_CONTROLS = Object.freeze([
  { id: 'unlimited', label: 'Unlimited', category: 'casual', initial: null, increment: 0 },
  { id: 'bullet-1+0', label: '1 + 0', category: 'bullet', initial: 60_000, increment: 0 },
  { id: 'bullet-2+1', label: '2 + 1', category: 'bullet', initial: 120_000, increment: 1_000 },
  { id: 'blitz-3+0', label: '3 + 0', category: 'blitz', initial: 180_000, increment: 0 },
  { id: 'blitz-3+2', label: '3 + 2', category: 'blitz', initial: 180_000, increment: 2_000 },
  { id: 'blitz-5+0', label: '5 + 0', category: 'blitz', initial: 300_000, increment: 0 },
  { id: 'blitz-5+3', label: '5 + 3', category: 'blitz', initial: 300_000, increment: 3_000 },
  { id: 'rapid-10+0', label: '10 + 0', category: 'rapid', initial: 600_000, increment: 0 },
  { id: 'rapid-10+5', label: '10 + 5', category: 'rapid', initial: 600_000, increment: 5_000 },
  { id: 'rapid-15+10', label: '15 + 10', category: 'rapid', initial: 900_000, increment: 10_000 },
  {
    id: 'classical-30+20',
    label: '30 + 20',
    category: 'classical',
    initial: 1_800_000,
    increment: 20_000,
  },
]);

export function timeControlById(id) {
  return TIME_CONTROLS.find((control) => control.id === id) ?? TIME_CONTROLS[0];
}

/**
 * Events: `tick` ({w, b, running}), `flag` ({color}), `start`, `stop`.
 */
export class Clock extends Emitter {
  /**
   * @param {{ initial: number|null, increment?: number, delayMode?: 'fischer'|'bronstein',
   *           now?: () => number, lowTimeMs?: number }} options
   */
  constructor({
    initial,
    increment = 0,
    delayMode = 'fischer',
    now = () => performance.now(),
    lowTimeMs = 30_000,
  } = {}) {
    super();
    this.initial = initial;
    this.increment = increment;
    this.delayMode = delayMode;
    this.lowTimeMs = lowTimeMs;
    this.now = now;

    /** Remaining ms per side; null means untimed. */
    this.remaining = { [WHITE]: initial, [BLACK]: initial };
    this.running = null;
    this.startedAt = null;
    /** Ms elapsed on the current turn, snapshotted on each stop. */
    this.lastMoveTime = 0;
    this.flagged = null;
    this.#lowWarned = { [WHITE]: false, [BLACK]: false };
  }

  #lowWarned;

  get isUntimed() {
    return this.initial === null;
  }

  /** Ms left for `color` right now, accounting for time ticking away. */
  timeLeft(color) {
    if (this.isUntimed) return null;
    const base = this.remaining[color];
    if (this.running !== color) return base;
    return Math.max(0, base - (this.now() - this.startedAt));
  }

  /**
   * Hands the move to `color` and starts their clock.
   *
   * Pressing for the side already running is a no-op rather than a restart:
   * resetting `startedAt` would silently forgive every second they had already
   * spent, so navigating the move list mid-game handed back free time.
   */
  press(color) {
    if (this.isUntimed) return;
    if (this.running === color) return;
    if (this.running) this.#stopRunning({ applyIncrement: true });
    this.running = color;
    this.startedAt = this.now();
    this.emit('start', { color });
  }

  /** Stops the clock without giving the move away (game over, pause). */
  stop() {
    if (this.isUntimed || !this.running) return;
    this.#stopRunning({ applyIncrement: false });
    this.emit('stop', {});
  }

  #stopRunning({ applyIncrement }) {
    const color = this.running;
    const elapsed = this.now() - this.startedAt;
    this.lastMoveTime = elapsed;

    if (applyIncrement && this.increment) {
      if (this.delayMode === 'bronstein') {
        // Bronstein gives back only what was actually used, capped at the increment.
        this.remaining[color] -= Math.max(0, elapsed - Math.min(elapsed, this.increment));
      } else {
        this.remaining[color] = this.remaining[color] - elapsed + this.increment;
      }
    } else {
      this.remaining[color] -= elapsed;
    }

    this.remaining[color] = Math.max(0, this.remaining[color]);
    this.running = null;
    this.startedAt = null;
  }

  /**
   * Recomputes state and emits `tick`; call once per animation frame. Emits
   * `flag` exactly once per side when their time runs out.
   */
  update() {
    if (this.isUntimed) return null;
    const snapshot = {
      [WHITE]: this.timeLeft(WHITE),
      [BLACK]: this.timeLeft(BLACK),
      running: this.running,
    };
    for (const color of [WHITE, BLACK]) {
      if (snapshot[color] <= this.lowTimeMs && !this.#lowWarned[color] && snapshot[color] > 0) {
        this.#lowWarned[color] = true;
        this.emit('lowtime', { color, remaining: snapshot[color] });
      }
      if (snapshot[color] <= 0 && this.flagged === null && this.running === color) {
        this.flagged = color;
        this.remaining[color] = 0;
        this.running = null;
        this.emit('flag', { color });
      }
    }
    this.emit('tick', snapshot);
    return snapshot;
  }

  reset({ initial = this.initial, increment = this.increment } = {}) {
    this.initial = initial;
    this.increment = increment;
    this.remaining = { [WHITE]: initial, [BLACK]: initial };
    this.running = null;
    this.startedAt = null;
    this.flagged = null;
    this.lastMoveTime = 0;
    this.#lowWarned = { [WHITE]: false, [BLACK]: false };
    this.emit('tick', { [WHITE]: initial, [BLACK]: initial, running: null });
  }

  toJSON() {
    return {
      initial: this.initial,
      increment: this.increment,
      delayMode: this.delayMode,
      remaining: {
        ...this.remaining,
        [this.running ?? WHITE]: this.timeLeft(this.running ?? WHITE),
      },
      flagged: this.flagged,
    };
  }
}

/** `9:07`, `0:09.4` under ten seconds, `1:02:33` over an hour. */
export function formatTime(ms) {
  if (ms === null || ms === undefined) return '∞';
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds)).padStart(2, '0')}`;
  }
  if (clamped < 10_000) return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
  return `${minutes}:${String(Math.floor(seconds)).padStart(2, '0')}`;
}
