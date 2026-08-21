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
