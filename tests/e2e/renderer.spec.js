import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Counts distinct pixel colours in a PNG buffer. A board that failed to draw
 * comes back as a flat fill; a board that drew has hundreds of shades from the
 * lighting alone.
 */
async function distinctColours(buffer) {
  const png = PNG.sync.read(buffer);
  const seen = new Set();
  for (let i = 0; i < png.data.length; i += 4 * 13) {
    seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  }
  return seen.size;
}

/**
 * The renderer can only really be verified in a browser: everything interesting
 * about it (WebGL context creation, geometry loading over fetch, the importmap)
 * is absent under vitest. These tests assert that it boots, draws something,
 * and survives the switches that used to leak a context on every click.
 */

/** Fails the test on any console error or page exception. */
function guardConsole(page, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
}

test('sandbox boots and renders the start position', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);

  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  const canvas = page.locator('#board canvas');
  await expect(canvas).toBeVisible();

  const pieceCount = await page.evaluate(() => window.__board.pieces.size);
  expect(pieceCount).toBe(32);

  // The drawing buffer is discarded after compositing (preserveDrawingBuffer is
  // off, as it should be), so read the composited page instead of the GL buffer.
  const shot = await canvas.screenshot({ path: 'test-results/shots/start-position.png' });
  expect(shot.length).toBeGreaterThan(10_000);
  expect(await distinctColours(shot)).toBeGreaterThan(500);

  expect(errors).toEqual([]);
});

test('plays a line and keeps the board in sync with the rules', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  await page.click('#play');
  await page.waitForFunction(() => window.__sandboxApi.game.tree.mainline().length === 10, {
    timeout: 30_000,
  });

  const state = await page.evaluate(() => ({
    fen: window.__sandboxApi.game.fen,
    rendered: Object.fromEntries(
      [...window.__board.pieces].map(([square, group]) => [square, group.userData.pieceCode]),
    ),
    model: window.__sandboxApi.game.position(),
  }));

  // Najdorf after 10 plies; a capture happened, so the piece count must drop.
  expect(Object.keys(state.model)).toHaveLength(30);
  expect(state.rendered).toEqual(state.model);
  expect(errors).toEqual([]);
});

test('theme, piece-set and camera switches do not leak or throw', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  for (const theme of ['marble', 'obsidian', 'neon', 'ivory', 'emerald', 'tournament']) {
    await page.selectOption('#theme', theme);
    await page.waitForTimeout(120);
  }
  for (const set of ['iconic', 'minions', 'classic']) {
    await page.selectOption('#pieceSet', set);
    await page.waitForTimeout(400);
  }
  for (const mode of ['top', 'low', 'cinematic', 'orbit']) {
    await page.selectOption('#camera', mode);
    await page.waitForTimeout(120);
  }
  await page.click('#flip');
  await page.waitForTimeout(1100);

  const summary = await page.evaluate(() => ({
    pieces: window.__board.pieces.size,
    orientation: window.__board.orientation(),
    canvases: document.querySelectorAll('canvas').length,
  }));
  expect(summary.pieces).toBe(32);
  expect(summary.orientation).toBe('black');
  // One canvas for the board; texture canvases are never attached to the DOM.
  expect(summary.canvases).toBe(1);
  expect(errors).toEqual([]);
});

test('captures a screenshot of every theme', async ({ page }) => {
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });
  await page.click('#play');
  await page.waitForFunction(() => window.__sandboxApi.game.tree.mainline().length === 10, {
    timeout: 30_000,
  });

  const canvas = page.locator('#board canvas');
  for (const theme of ['tournament', 'marble', 'obsidian', 'emerald', 'neon', 'ivory']) {
    await page.selectOption('#theme', theme);
    await page.waitForTimeout(500);
    const shot = await canvas.screenshot({ path: `test-results/shots/theme-${theme}.png` });
    // Each theme must actually draw something, not just tint the background.
    expect(await distinctColours(shot), `${theme} rendered flat`).toBeGreaterThan(400);
  }
});

test('a capture removes the captured piece, not the capturing one', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  const outcome = await page.evaluate(async () => {
    const board = window.__board;
    const { fenToPosition } = await import('/src/core/positionDiff.js');
    await board.setPosition(
      fenToPosition('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'),
      { animate: false },
    );
    // exd5: the plan is `move e4->d5` plus `clear d5`, and both name the same
    // square. Resolving the removal by square took the arriving pawn instead.
    await board.setPosition(
      fenToPosition('rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2'),
      { animate: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    return {
      indexed: Object.fromEntries(
        [...board.pieces].map(([square, group]) => [square, group.userData.pieceCode]),
      ),
      // The scene graph is where the orphan would linger: a piece removed from
      // the index but never detached stays visible forever.
      sceneChildren: board.pieceGroup.children.length,
      d5: board.pieces.get('d5')?.userData.pieceCode ?? null,
    };
  });

  expect(outcome.d5).toBe('wP');
  expect(Object.keys(outcome.indexed)).toHaveLength(31);
  expect(outcome.sceneChildren, 'an orphaned mesh was left in the scene').toBe(31);
  expect(errors).toEqual([]);
});
