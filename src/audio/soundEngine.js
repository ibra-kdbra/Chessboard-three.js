/**
 * Procedural sound.
 *
 * The old README credited move and check sounds that were never in the
 * repository. Rather than add binary assets, every sound here is synthesised
 * with Web Audio at play time: nothing to download, nothing to cache, and each
 * cue can be varied slightly so repeated moves don't sound like a loop.
 *
 * The context stays suspended until the first user gesture, which is what
 * browsers require anyway.
 */

/** Equal-tempered frequency for a MIDI note number. */
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export class SoundEngine {
  constructor({ enabled = true, volume = 0.6 } = {}) {
    this.enabled = enabled;
    this.volume = volume;
    /** @type {AudioContext | null} */
    this.context = null;
    this.master = null;
  }

  get isSupported() {
    return typeof window !== 'undefined' && !!(window.AudioContext ?? window.webkitAudioContext);
  }

  /** Safe to call on every gesture; only the first one does anything. */
  resume() {
    if (!this.isSupported || !this.enabled) return null;
    if (!this.context) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      // A gentle limiter keeps stacked cues (capture + check) from clipping.
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.ratio.value = 12;
      this.master.connect(limiter).connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume();
    return this.context;
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.context?.state === 'running') this.context.suspend();
    else if (enabled) this.resume();
  }

  /** A short pitched blip: the building block for most cues. */
  #tone({ frequency, duration = 0.12, type = 'sine', gain = 0.3, delay = 0, detune = 0, sweepTo = null }) {
    const ctx = this.context;
    if (!ctx) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
    osc.detune.value = detune;

    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(envelope).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** Filtered noise: the wooden "knock" of a piece meeting the board. */
  #noise({ duration = 0.09, gain = 0.35, frequency = 1400, q = 1.2, delay = 0, type = 'bandpass' }) {
    const ctx = this.context;
    if (!ctx) return;
    const start = ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Decaying white noise; the exponent shapes the "thock" into a click.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2.2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = ctx.createGain();
    envelope.gain.value = gain;
    source.connect(filter).connect(envelope).connect(this.master);
    source.start(start);
  }

  #play(name) {
    if (!this.enabled) return;
    if (!this.resume()) return;
    // ±3% pitch jitter so a run of quiet moves doesn't sound mechanical.
    const jitter = 1 + (Math.random() - 0.5) * 0.06;

    switch (name) {
      case 'move':
        this.#noise({ frequency: 1100 * jitter, gain: 0.28, duration: 0.07 });
        this.#tone({ frequency: 180 * jitter, duration: 0.07, type: 'triangle', gain: 0.12 });
        break;
      case 'capture':
        this.#noise({ frequency: 700 * jitter, gain: 0.42, duration: 0.13, q: 0.7 });
        this.#noise({ frequency: 2400, gain: 0.16, duration: 0.05, delay: 0.02 });
        this.#tone({ frequency: 120 * jitter, duration: 0.11, type: 'square', gain: 0.1 });
        break;
      case 'castle':
        this.#noise({ frequency: 1100, gain: 0.24, duration: 0.06 });
        this.#noise({ frequency: 950, gain: 0.24, duration: 0.07, delay: 0.11 });
        break;
      case 'check':
        this.#tone({ frequency: hz(76), duration: 0.13, type: 'triangle', gain: 0.22 });
        this.#tone({ frequency: hz(83), duration: 0.16, type: 'triangle', gain: 0.2, delay: 0.09 });
        break;
      case 'checkmate':
        [72, 76, 79, 84].forEach((note, index) => {
          this.#tone({ frequency: hz(note), duration: 0.34, type: 'triangle', gain: 0.2, delay: index * 0.1 });
        });
        break;
      case 'promote':
        this.#tone({ frequency: hz(69), duration: 0.5, type: 'sine', gain: 0.18, sweepTo: hz(88) });
        this.#tone({ frequency: hz(76), duration: 0.4, type: 'sine', gain: 0.1, delay: 0.08, sweepTo: hz(93) });
        break;
      case 'illegal':
        this.#tone({ frequency: 150, duration: 0.16, type: 'sawtooth', gain: 0.1, sweepTo: 90 });
        break;
      case 'lowtime':
        this.#tone({ frequency: hz(88), duration: 0.06, type: 'square', gain: 0.14 });
        break;
      case 'flag':
      case 'gameover':
        [72, 68, 65, 60].forEach((note, index) => {
          this.#tone({ frequency: hz(note), duration: 0.3, type: 'sine', gain: 0.16, delay: index * 0.12 });
        });
        break;
      case 'select':
        this.#tone({ frequency: 900 * jitter, duration: 0.035, type: 'sine', gain: 0.07 });
        break;
      case 'start':
        [60, 64, 67, 72].forEach((note, index) => {
          this.#tone({ frequency: hz(note), duration: 0.22, type: 'triangle', gain: 0.13, delay: index * 0.07 });
        });
        break;
      default:
        break;
    }
  }

  /**
   * Picks the right cue for a move. Checkmate wins over check, which wins over
   * the capture/quiet distinction — the most important thing gets heard.
   */
  playMove(move, { isCheck = false, isCheckmate = false } = {}) {
    if (isCheckmate) return this.#play('checkmate');
    if (isCheck) return this.#play('check');
    if (move?.promotion) return this.#play('promote');
    if (move?.flags?.includes('k') || move?.flags?.includes('q')) return this.#play('castle');
    if (move?.captured) return this.#play('capture');
    return this.#play('move');
  }

  play(name) {
    return this.#play(name);
  }

  /** Short vibration on mobile, where a sound may be muted anyway. */
  haptic(pattern = 12) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch {
        /* ignore: some browsers reject vibration outside a gesture */
      }
    }
  }
}

export const SOUND_NAMES = Object.freeze([
  'move', 'capture', 'castle', 'check', 'checkmate', 'promote',
  'illegal', 'lowtime', 'flag', 'gameover', 'select', 'start',
]);
