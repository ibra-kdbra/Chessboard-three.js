import { describe, expect, it } from 'vitest';
import { RENDERER_METHODS, assertRendererContract } from '../../src/render/boardRenderer.js';

/**
 * Both renderers are checked against the contract in the browser suite, where
 * they can actually be constructed. This covers the contract itself, which is
 * what makes the 2D/3D switch a swap rather than a special case.
 */
describe('BoardRenderer contract', () => {
  it('accepts an object implementing every method', () => {
    const stub = { capabilities: {} };
    for (const method of RENDERER_METHODS) stub[method] = () => {};
    expect(assertRendererContract(stub)).toBe(true);
  });

  it('names exactly what is missing', () => {
    const stub = { capabilities: {} };
    for (const method of RENDERER_METHODS) stub[method] = () => {};
    delete stub.setArrows;
    delete stub.orientation;
    expect(() => assertRendererContract(stub, 'Board2D')).toThrow(/setArrows/);
    expect(() => assertRendererContract(stub, 'Board2D')).toThrow(/orientation/);
    expect(() => assertRendererContract(stub, 'Board2D')).toThrow(/Board2D/);
  });

  it('requires capabilities to be declared', () => {
    const stub = {};
    for (const method of RENDERER_METHODS) stub[method] = () => {};
    expect(() => assertRendererContract(stub)).toThrow(/capabilities/);
  });
});

describe('Ticker pause and resume', () => {
  it('resumes a tween where it left off rather than from the start', async () => {
    const { Ticker, easing } = await import('../../src/render/three/animation.js');
    const ticker = new Ticker();
    const seen = [];
    ticker.add({ duration: 100, ease: easing.linear, onUpdate: (t) => seen.push(t) });

    ticker.update(0);
    ticker.update(40);
    ticker.pause(40);
    // Time passes while paused — a backgrounded tab, or an open modal.
    ticker.update(5000);
    ticker.resume(5000);
    ticker.update(5020);

    // Without the rebase this jumped straight to 1 (or back to 0).
    const last = seen.at(-1);
    expect(last).toBeGreaterThan(0.4);
    expect(last).toBeLessThan(0.8);
  });

  it('does not advance while paused', async () => {
    const { Ticker, easing } = await import('../../src/render/three/animation.js');
    const ticker = new Ticker();
    let calls = 0;
    ticker.add({ duration: 100, ease: easing.linear, onUpdate: () => calls++ });

    ticker.update(0);
    const before = calls;
    ticker.pause(0);
    ticker.update(50);
    expect(calls).toBe(before);
  });
});
