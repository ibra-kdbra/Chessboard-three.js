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
