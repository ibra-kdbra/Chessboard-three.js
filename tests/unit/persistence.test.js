import { beforeEach, describe, expect, it } from 'vitest';

/**
 * persistence.js guards every read, because storage throws outright in some
 * privacy modes and a blob saved by an older version can be structurally
 * wrong. Those guards are the whole point of the module and were never
 * exercised — a browser test cannot easily produce a corrupt blob or a storage
 * that refuses to write.
 *
 * `storageAvailable` is probed once at module load, so the fake has to be in
 * place before the import.
 */
const entries = new Map();
globalThis.localStorage = {
  getItem: (name) => (entries.has(name) ? entries.get(name) : null),
  setItem: (name, value) => entries.set(name, String(value)),
  removeItem: (name) => entries.delete(name),
};

const store = await import('../../src/app/persistence.js');
const KEY = 'chessboard3:v1';

beforeEach(() => entries.clear());

describe('settings', () => {
  it('fills in a setting the saved blob predates', () => {
    entries.set(`${KEY}:settings`, JSON.stringify({ theme: 'marble' }));
    const settings = store.loadSettings();
    expect(settings.theme).toBe('marble');
    // Everything else must still be present, or the app boots with undefined
    // where it expects a value.
    expect(settings.difficulty).toBe(store.DEFAULT_SETTINGS.difficulty);
    expect(Object.keys(settings).length).toBe(Object.keys(store.DEFAULT_SETTINGS).length);
  });

  it('ignores a stored value that is not an object', () => {
    for (const junk of ['"a string"', '42', 'null', '[1,2,3]']) {
      entries.set(`${KEY}:settings`, junk);
      expect(store.loadSettings().theme).toBe(store.DEFAULT_SETTINGS.theme);
    }
  });

  it('falls back to the defaults when the blob is not JSON at all', () => {
    entries.set(`${KEY}:settings`, '{ this is not json');
    expect(store.loadSettings()).toEqual({ ...store.DEFAULT_SETTINGS });
  });
});

describe('the in-progress game', () => {
  const game = { state: { tree: { children: [] } }, mode: 'engine' };

  it('stamps a version so a later format can be told apart', () => {
    store.saveCurrentGame(game);
    expect(store.loadCurrentGame()).toMatchObject({ version: 1, mode: 'engine' });
  });

  it('refuses a blob from another version or without a tree', () => {
    entries.set(`${KEY}:current-game`, JSON.stringify({ version: 2, state: { tree: {} } }));
    expect(store.loadCurrentGame()).toBeNull();
    entries.set(`${KEY}:current-game`, JSON.stringify({ version: 1, state: {} }));
    expect(store.loadCurrentGame()).toBeNull();
    entries.set(`${KEY}:current-game`, 'null');
    expect(store.loadCurrentGame()).toBeNull();
  });

  it('still loads a blob saved before the settings copy was dropped', () => {
    // The serialiser used to embed a second settings object. Old saves must
    // keep working; the extra key is simply ignored.
    entries.set(
      `${KEY}:current-game`,
      JSON.stringify({ version: 1, ...game, settings: { theme: 'neon' } }),
    );
    expect(store.loadCurrentGame()?.mode).toBe('engine');
  });

  it('clears', () => {
    store.saveCurrentGame(game);
    store.clearCurrentGame();
    expect(store.loadCurrentGame()).toBeNull();
  });
});

describe('the library', () => {
  it('keeps the newest game first', () => {
    store.addToLibrary({ pgn: 'first' });
    store.addToLibrary({ pgn: 'second' });
    expect(store.loadLibrary().map((e) => e.pgn)).toEqual(['second', 'first']);
  });

  it('caps the list so storage cannot fill up', () => {
    for (let i = 0; i < 60; i++) store.addToLibrary({ pgn: `game ${i}` });
    const list = store.loadLibrary();
    expect(list.length).toBe(50);
    // The cap drops the oldest, not the newest.
    expect(list[0].pgn).toBe('game 59');
  });

  it('removes by id and leaves the rest alone', () => {
    store.addToLibrary({ pgn: 'keep me' });
    store.addToLibrary({ pgn: 'drop me' });
    const target = store.loadLibrary().find((e) => e.pgn === 'drop me');
    store.removeFromLibrary(target.id);
    expect(store.loadLibrary().map((e) => e.pgn)).toEqual(['keep me']);
  });

  it('recovers when the stored list is not a list', () => {
    entries.set(`${KEY}:library`, JSON.stringify({ not: 'an array' }));
    expect(store.loadLibrary()).toEqual([]);
  });
});

describe('when storage refuses', () => {
  it('reports a failed write rather than throwing', () => {
    const setItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    try {
      expect(store.write('settings', { theme: 'neon' })).toBe(false);
    } finally {
      globalThis.localStorage.setItem = setItem;
    }
  });

  it('returns the fallback rather than throwing when a read blows up', () => {
    const getItem = globalThis.localStorage.getItem;
    globalThis.localStorage.getItem = () => {
      throw new Error('storage is gone');
    };
    try {
      expect(store.read('settings', 'fallback')).toBe('fallback');
    } finally {
      globalThis.localStorage.getItem = getItem;
    }
  });
});
