import { describe, expect, it, vi } from 'vitest';
import { Clock, TIME_CONTROLS, formatTime, timeControlById } from '../../src/core/clock.js';

/** A clock driven by a value we control, so no test has to wait for real time. */
function fakeClock(options = {}) {
  let now = 0;
  const clock = new Clock({ now: () => now, ...options });
  return { clock, advance: (ms) => (now += ms) };
}

describe('Clock', () => {
  it('adds a Fischer increment after the move', () => {
    const { clock, advance } = fakeClock({ initial: 10_000, increment: 2_000 });
    clock.press('w');
    advance(3_000);
    clock.press('b');

    expect(clock.timeLeft('w')).toBe(9_000); // 10 - 3 + 2
    expect(clock.timeLeft('b')).toBe(10_000);
  });

  it('gives back only the time used under Bronstein, up to the delay', () => {
    const short = fakeClock({ initial: 10_000, increment: 2_000, delayMode: 'bronstein' });
    short.clock.press('w');
    short.advance(1_000);
    short.clock.press('b');
    expect(short.clock.timeLeft('w')).toBe(10_000);

    const long = fakeClock({ initial: 10_000, increment: 2_000, delayMode: 'bronstein' });
    long.clock.press('w');
    long.advance(5_000);
    long.clock.press('b');
    expect(long.clock.timeLeft('w')).toBe(7_000);
  });

  it('flags exactly once, and only for the side that ran out', () => {
    const { clock, advance } = fakeClock({ initial: 1_000 });
    const onFlag = vi.fn();
    clock.on('flag', onFlag);

    clock.press('w');
    advance(1_500);
    clock.update();
    clock.update();

    expect(onFlag).toHaveBeenCalledTimes(1);
    expect(onFlag).toHaveBeenCalledWith({ color: 'w' });
    expect(clock.timeLeft('w')).toBe(0);
    expect(clock.timeLeft('b')).toBe(1_000);
  });

  it('warns once when a side drops below the low-time threshold', () => {
    const { clock, advance } = fakeClock({ initial: 40_000, lowTimeMs: 30_000 });
    const onLow = vi.fn();
    clock.on('lowtime', onLow);

    clock.press('w');
    advance(11_000);
    clock.update();
    advance(1_000);
    clock.update();

    expect(onLow).toHaveBeenCalledTimes(1);
  });

  it('never reports a negative time', () => {
    const { clock, advance } = fakeClock({ initial: 500 });
    clock.press('w');
    advance(9_000);
    expect(clock.timeLeft('w')).toBe(0);
  });

  it('does nothing at all when untimed', () => {
    const { clock, advance } = fakeClock({ initial: null });
    clock.press('w');
    advance(60_000);

    expect(clock.isUntimed).toBe(true);
    expect(clock.timeLeft('w')).toBeNull();
    expect(clock.update()).toBeNull();
  });
});

describe('formatTime', () => {
  it('shows tenths only under ten seconds', () => {
    expect(formatTime(547_000)).toBe('9:07');
    expect(formatTime(9_400)).toBe('0:09.4');
    expect(formatTime(3_753_000)).toBe('1:02:33');
    expect(formatTime(null)).toBe('∞');
    expect(formatTime(-50)).toBe('0:00.0');
  });
});

describe('time controls', () => {
  it('has a unique id for every preset and falls back safely', () => {
    const ids = TIME_CONTROLS.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(timeControlById('nonsense').id).toBe('unlimited');
  });
});
