import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { bookContinuations, identifyOpening, pickBookMove } from '../../src/core/openings.js';
import { OPENING_TABLE } from '../../src/data/openings.js';

describe('opening book', () => {
  it('every catalogued line is legal from the start position', () => {
    // The book is generated from a hand-maintained dataset; a wrong SAN string
    // shows up as a wrong opening name, which is worse than none.
    for (const [line] of OPENING_TABLE) {
      const chess = new Chess();
      for (const san of line.split(' ')) {
        expect(() => chess.move(san), `${line} — ${san}`).not.toThrow();
      }
    }
  });

  it('names the most specific line that still matches', () => {
    expect(identifyOpening(['e4', 'c5'])).toMatchObject({ eco: 'B20', name: 'Sicilian' });
    expect(
      identifyOpening(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']),
    ).toMatchObject({ eco: 'B90', name: 'Sicilian, Najdorf' });
    expect(identifyOpening(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])).toMatchObject({
      name: 'Nimzo-Indian',
    });
    expect(identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toMatchObject({ name: 'Ruy Lopez' });
  });

  it('keeps the last known name when play leaves theory', () => {
    const known = identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    const wandered = identifyOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'h6', 'h3', 'a5']);
    expect(wandered.name).toBe(known.name);
  });

  it('returns null only when nothing matches at all', () => {
    expect(identifyOpening([])).toBeNull();
  });

  it('weights continuations by how well catalogued they are', () => {
    const first = bookContinuations([]);
    const byName = Object.fromEntries(first.map((entry) => [entry.san, entry.weight]));
    expect(byName.d4).toBeGreaterThan(byName.g4);
    expect(byName.e4).toBeGreaterThan(byName.a3);
    // Sorted best-catalogued first.
    expect(first[0].weight).toBeGreaterThanOrEqual(first.at(-1).weight);
  });

  it('samples in proportion to that weight', () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const counts = {};
    for (let i = 0; i < 3000; i++) {
      const pick = pickBookMove([], random);
      counts[pick.san] = (counts[pick.san] ?? 0) + 1;
    }
    expect(counts.d4 + counts.e4).toBeGreaterThan(2000);
    expect(counts.g4 ?? 0).toBeLessThan(100);
  });

  it('offers nothing once the line is out of book', () => {
    expect(pickBookMove(['a3', 'h6', 'a4', 'h5', 'Ra3'])).toBeNull();
  });
});
