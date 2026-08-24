import { describe, expect, it } from 'vitest';
import { buildShareUrl, readShareTarget, suggestFilename } from '../../src/app/share.js';

/** Stands in for the page the link is built from. */
const PAGE = 'https://example.test/chess/';

/**
 * share.js reads the location hash and the clock, but both arrive as arguments
 * with defaults, so the parts that decide anything run in node. Only
 * `copyText`, `downloadText` and `clearShareTarget` genuinely need a document;
 * those stay covered by the browser tests.
 */

describe('share links', () => {
  it('round-trips a game through the fragment', () => {
    const url = buildShareUrl({ pgn: '1. e4 e5 2. Nf3 *' }, PAGE);
    const target = readShareTarget(new URL(url).hash);
    expect(target.pgn).toBe('1. e4 e5 2. Nf3 *');
  });

  it('round-trips a position', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const target = readShareTarget(new URL(buildShareUrl({ fen }, PAGE)).hash);
    expect(target.fen).toBe(fen);
  });

  it('carries the game in the fragment, never the query', () => {
    // The fragment is not sent to the server. A game in the query string would
    // be logged by every hop between the player and the host.
    const url = new URL(buildShareUrl({ pgn: '1. d4 *' }, PAGE));
    expect(url.search).toBe('');
    expect(url.hash.length).toBeGreaterThan(1);
  });

  it('survives a PGN full of characters that need encoding', () => {
    const pgn = '[Event "Ünicode & co"]\n\n1. e4 {a comment} e5 2. Nf3! Nc6? *';
    expect(readShareTarget(new URL(buildShareUrl({ pgn }, PAGE)).hash).pgn).toBe(pgn);
  });

  it('reads nothing from an empty or foreign hash', () => {
    expect(readShareTarget('')).toBeNull();
    expect(readShareTarget('#')).toBeNull();
    expect(readShareTarget('#section-2')).toBeNull();
  });

  it('does not throw on a malformed fragment', () => {
    expect(() => readShareTarget('#pgn=%%%')).not.toThrow();
  });
});

describe('suggested filenames', () => {
  it('names the file after the opening and the date', () => {
    const name = suggestFilename('Sicilian, Najdorf', new Date(Date.UTC(2024, 2, 9)));
    expect(name).toMatch(/\.pgn$/);
    expect(name).toContain('2024');
  });

  it('produces a filename a filesystem will accept', () => {
    const name = suggestFilename(
      "King's Indian: Fianchetto/Classical",
      new Date(Date.UTC(2024, 0, 1)),
    );
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('still returns a name when the opening is unknown', () => {
    const name = suggestFilename('', new Date(Date.UTC(2024, 0, 1)));
    expect(name).toMatch(/\.pgn$/);
    expect(name.length).toBeGreaterThan(4);
  });
});
