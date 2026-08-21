import { test, expect } from '@playwright/test';

/**
 * Engine tests have to run in a browser: these are classic-script Web Workers,
 * and two of the three behave differently under node than they do in a page
 * (Lozza switches its move notation based on which host it thinks it is on).
 *
 * The point of these tests is the quirks. Each engine deviates from UCI in its
 * own way, engineProfiles.js declares those deviations, and the only way to
 * know the declarations are still true is to ask the engines.
 */

const SANDBOX = '/sandbox.html';

/** Runs `fn` in the page with the engine modules imported. */
async function withEngines(page, fn, arg) {
  await page.goto(SANDBOX);
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });
  return page.evaluate(async (payload) => {
    const uci = await import('/src/engine/uciEngine.js');
    const profiles = await import('/src/engine/engineProfiles.js');
    window.__uci = uci;
    window.__profiles = profiles;
    return (0, eval)(`(${payload.source})`)({ uci, profiles }, payload.arg);
  }, { source: fn.toString(), arg });
}

for (const id of ['lozza', 'stockfish', 'p4wn']) {
  test(`${id} completes a handshake and returns a legal move`, async ({ page }) => {
    test.setTimeout(120_000);
    const result = await withEngines(
      page,
      async ({ uci, profiles }, engineId) => {
        const engine = new uci.UciEngine({ profile: engineId });
        await engine.start();
        const search = await engine.search(
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          { movetime: 400 },
        );
        const capabilities = engine.capabilities;
        const declared = [...engine.options.keys()];
        engine.dispose();
        return {
          id: engine.id,
          bestmove: search.bestmove,
          score: search.info?.score ?? null,
          pvFormat: search.lines[0]?.pvFormat ?? null,
          capabilities,
          declaredOptionCount: declared.length,
          profileMatchesReality: {
            multiPv: capabilities.multiPv === (profiles.getEngineProfile(engineId).id === 'stockfish'),
          },
        };
      },
      id,
    );

    // Every engine must produce a legal first move in coordinate notation.
    expect(result.bestmove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    expect(result.id, `${id} did not identify itself`).toBeTruthy();
  });
}

test('profiles match what the engines actually declare', async ({ page }) => {
  test.setTimeout(120_000);
  const declared = await withEngines(page, async ({ uci }) => {
    const out = {};
    for (const id of ['lozza', 'stockfish', 'p4wn']) {
      const engine = new uci.UciEngine({ profile: id });
      await engine.start();
      out[id] = {
        options: [...engine.options.keys()].sort(),
        capabilities: engine.capabilities,
      };
      engine.dispose();
    }
    return out;
  });

  // Stockfish 5 has MultiPV and Skill Level but NOT UCI_Elo (added in SF11).
  expect(declared.stockfish.options).toContain('MultiPV');
  expect(declared.stockfish.options).toContain('Skill Level');
  expect(declared.stockfish.options).not.toContain('UCI_Elo');
  expect(declared.stockfish.capabilities.limitStrength).toBe(false);
  expect(declared.stockfish.capabilities.skillLevel).toBe(true);
  // Declared but inert: the build has no pthreads and cannot ponder.
  expect(declared.stockfish.capabilities.threads).toBe(false);
  expect(declared.stockfish.capabilities.ponder).toBe(false);

  // Lozza answers `uci` with a bare malformed `option` line; a strict parser
  // must record nothing rather than a garbage entry.
  expect(declared.lozza.options).toEqual([]);
  expect(declared.lozza.capabilities.multiPv).toBe(false);

  expect(declared.p4wn.options).toEqual([]);

  // No bundled engine can be interrupted: they search on the worker's own
  // event loop, so cancellation means discarding the worker.
  for (const id of ['lozza', 'stockfish', 'p4wn']) {
    expect(declared[id].capabilities.stop, `${id} claims stop works`).toBe(false);
    expect(declared[id].capabilities.cancelByTerminate).toBe(true);
  }
});

test('p4wn evaluations survive its reversed bestmove/info order', async ({ page }) => {
  test.setTimeout(120_000);
  const result = await withEngines(page, async ({ uci }) => {
    const engine = new uci.UciEngine({ profile: 'p4wn' });
    await engine.start();
    // White is a queen up; the sign of the score is what matters here.
    const search = await engine.search('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
      depth: 3,
    });
    engine.dispose();
    return { bestmove: search.bestmove, score: search.info?.score ?? null };
  });

  expect(result.bestmove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
  // p4wn posts `info` after `bestmove`; an adapter that settles on bestmove
  // throws the only evaluation it ever gives away.
  expect(result.score, 'p4wn score was dropped').not.toBeNull();
});

test('cancelling a search leaves the engine usable', async ({ page }) => {
  test.setTimeout(120_000);
  const result = await withEngines(page, async ({ uci }) => {
    const engine = new uci.UciEngine({ profile: 'lozza' });
    await engine.start();
    const pending = engine.search('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
      movetime: 5000,
    });
    const rejected = pending.then(() => 'resolved').catch((error) => error.message);
    await engine.cancel();
    const outcome = await rejected;
    // The engine must still work afterwards — cancellation replaces the worker.
    const after = await engine.search('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
      movetime: 300,
    });
    engine.dispose();
    return { outcome, bestmoveAfter: after.bestmove };
  });

  expect(result.outcome).toContain('cancelled');
  expect(result.bestmoveAfter).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
});
