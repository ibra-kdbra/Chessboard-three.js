import { test, expect } from '@playwright/test';

/**
 * End-to-end coverage of the actual game, not of the renderer in isolation.
 * These are the paths a player takes on their first visit.
 */

function guard(page, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
}

/**
 * Waits until nothing is animating and the engine is idle.
 *
 * A fixed delay is a coin flip here: an engine search and a piece animation both
 * take however long the machine takes, and a timeout tuned on an idle laptop
 * fails on a loaded CI box. Waiting on the actual condition is both faster and
 * reliable.
 */
async function settled(page) {
  await page.waitForFunction(
    () =>
      window.__app?.board?.ticker?.active === false && window.__app?.session?.thinking === false,
    { timeout: 45_000 },
  );
}

/**
 * Loads the app with empty storage.
 *
 * Deliberately not addInitScript: that runs on *every* navigation, so it would
 * also wipe storage during the reload the persistence test is trying to
 * measure. Clearing once and reloading gives each test a clean start without
 * breaking the one test that cares about what survives.
 */
async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode: nothing to clear */
    }
  });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });
}

test('boots, shows the start position and a full move list', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await expect(page.locator('#board canvas')).toBeVisible();
  await expect(page.locator('.status')).toContainText('White to move');
  expect(await page.evaluate(() => window.__app.board.pieces.size)).toBe(32);
  expect(errors).toEqual([]);
});

test('a played move updates the board, the move list and the clock', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  // Enter a move by typing it, which exercises the keyboard path too.
  await page.locator('#board').focus();
  await page.keyboard.type('e4');
  await page.keyboard.press('Enter');

  await page.waitForFunction(() => window.__app.session.state.ply >= 1, { timeout: 20_000 });
  await expect(page.locator('.movelist__move').first()).toHaveText(/e4/);

  // The computer answers, so the game reaches two plies without further input.
  await page.waitForFunction(() => window.__app.session.state.ply >= 2, { timeout: 45_000 });
  await settled(page);

  const rendered = await page.evaluate(() => ({
    model: window.__app.session.state.position(),
    board: Object.fromEntries(
      [...window.__app.board.pieces].map(([square, group]) => [square, group.userData.pieceCode]),
    ),
  }));
  expect(rendered.board).toEqual(rendered.model);
  expect(errors).toEqual([]);
});

test('navigation moves through the game without desyncing', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await page.evaluate(async () => {
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) {
      window.__app.session.state.move(san);
    }
    window.__app.session.emit('status', window.__app.session.status());
  });
  await page.evaluate(() => window.__app.actions.end());
  await settled(page);
  await page.evaluate(() => window.__app.actions.start());
  await settled(page);

  const atStart = await page.evaluate(() => window.__app.session.state.fen);
  expect(atStart).toContain('rnbqkbnr/pppppppp');

  await page.evaluate(() => window.__app.actions.end());
  await settled(page);
  const atEnd = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    model: window.__app.session.state.position(),
    board: Object.fromEntries(
      [...window.__app.board.pieces].map(([square, group]) => [square, group.userData.pieceCode]),
    ),
  }));
  expect(atEnd.ply).toBe(4);
  expect(atEnd.board).toEqual(atEnd.model);
  expect(errors).toEqual([]);
});

test('the game survives a reload', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await page.evaluate(async () => {
    for (const san of ['d4', 'd5', 'c4']) window.__app.session.state.move(san);
    window.__app.session.emit('status', window.__app.session.status());
  });
  await page.evaluate(() => window.__app.actions.end());
  await settled(page);

  const before = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    return window.__app.session.state.pgn();
  });

  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });

  const after = await page.evaluate(() => window.__app.session.state.pgn());
  // The move text must survive; headers carry a fresh date and need not.
  const moves = (pgn) => pgn.split(/\n\n/).pop().trim();
  expect(moves(after)).toBe(moves(before));
  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
});

test('is usable on a phone-sized viewport', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);

  const canvas = page.locator('#board canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  // The page itself must never scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/shots/app-mobile.png' });
  expect(errors).toEqual([]);
});
