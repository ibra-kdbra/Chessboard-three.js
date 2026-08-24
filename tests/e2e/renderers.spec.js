import { test, expect } from '@playwright/test';

/**
 * Both renderers, checked against the same expectations.
 *
 * The point of the shared contract is that the 2D/3D switch is a swap. These
 * tests construct each one and put it through the same paces, so a method that
 * quietly diverges is caught rather than discovered by a user mid-game.
 */

const DIMENSIONS = [
  { name: '3D', module: '/src/render/three/board3d.js', ctor: 'Board3D', pieceSet: 'classic' },
  { name: '2D', module: '/src/render/two/board2d.js', ctor: 'Board2D', pieceSet: 'wikipedia' },
];

async function mount(page, spec) {
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });
  return page.evaluate(async (renderer) => {
    document.getElementById('board').innerHTML = '';
    window.__board?.destroy?.();
    const module = await import(renderer.module);
    const contract = await import('/src/render/boardRenderer.js');
    const instance = new module[renderer.ctor]('board', { pieceSet: renderer.pieceSet });
    window.__probe = instance;
    contract.assertRendererContract(instance, renderer.ctor);
    await new Promise((resolve) => {
      if (instance.ready) resolve();
      else instance.on('ready', resolve);
      setTimeout(resolve, 20_000);
    });
    return true;
  }, spec);
}

for (const spec of DIMENSIONS) {
  test(`${spec.name} renderer implements the contract and draws a position`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await mount(page, spec);

    const result = await page.evaluate(async () => {
      const board = window.__probe;
      const { fenToPosition } = await import('/src/core/positionDiff.js');
      const start = fenToPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      await board.setPosition(start, { animate: false });

      const orientation = board.orientation('flip');
      board.setHighlights({
        lastMove: { from: 'e2', to: 'e4' },
        check: 'e1',
        legal: [
          { to: 'e4', capture: false },
          { to: 'd5', capture: true },
        ],
        selected: 'e2',
      });
      board.setArrows([{ from: 'g1', to: 'f3' }]);
      board.setTheme('obsidian');
      board.setInteractive(false);
      board.setInteractive(true);
      board.resize();

      // Then move to a later position, animated, and confirm it lands.
      const after = fenToPosition(
        'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1',
      );
      await board.setPosition(after, { animate: true });

      return {
        orientation,
        position: board.getPosition(),
        expected: after,
        dimensions: board.capabilities.dimensions,
      };
    });

    expect(result.orientation).toBe('black');
    expect(result.position).toEqual(result.expected);
    expect(result.dimensions).toBe(spec.name === '3D' ? 3 : 2);

    const canvas = page.locator('#board canvas');
    await expect(canvas).toBeVisible();
    await canvas.screenshot({ path: `test-results/shots/renderer-${spec.name}.png` });

    expect(errors).toEqual([]);
  });
}

test('the app can switch between 2D and 3D without losing the game', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/index.html');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
  });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });

  await page.evaluate(() => {
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) window.__app.session.state.move(san);
    window.__app.actions.end();
  });

  await page.evaluate(() => window.__app.setDimensions(2));
  await page.waitForFunction(() => window.__app.board.capabilities.dimensions === 2, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__app.board.ready === true, { timeout: 30_000 });

  const in2d = await page.evaluate(() => ({
    dimensions: window.__app.board.capabilities.dimensions,
    rendered: window.__app.board.getPosition(),
    model: window.__app.session.state.position(),
    canvases: document.querySelectorAll('#board canvas').length,
  }));
  expect(in2d.dimensions).toBe(2);
  expect(in2d.rendered).toEqual(in2d.model);
  // The old renderer's canvas must be gone, not merely hidden.
  expect(in2d.canvases).toBe(1);
  await page.screenshot({ path: 'test-results/shots/app-2d.png' });

  await page.evaluate(() => window.__app.setDimensions(3));
  await page.waitForFunction(() => window.__app.board.capabilities.dimensions === 3, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__app.board.ready === true, { timeout: 30_000 });

  const back = await page.evaluate(() => ({
    rendered: Object.fromEntries(
      [...window.__app.board.pieces].map(([square, group]) => [square, group.userData.pieceCode]),
    ),
    model: window.__app.session.state.position(),
    canvases: document.querySelectorAll('#board canvas').length,
  }));
  expect(back.rendered).toEqual(back.model);
  expect(back.canvases).toBe(1);
  expect(errors).toEqual([]);
});

test('a second board swap during the first leaves exactly one board', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/index.html');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
  });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });

  // Both swaps are started without awaiting the first. The renderers load over
  // the network now, so this is an ordinary double-click on the Board select:
  // the old code read orientation off a board it had already destroyed and
  // mounted both, leaving an orphaned canvas on top of a live board that was
  // rendering off-screen — with nothing logged to say so.
  await page.evaluate(() => {
    window.__app.setDimensions(2);
    window.__app.setDimensions(3);
  });
  await page.waitForFunction(() => window.__app.board.ready === true, { timeout: 45_000 });
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const host = document.getElementById('board');
    return {
      canvases: host.querySelectorAll('canvas').length,
      mounted: window.__app.board.capabilities.dimensions,
      setting: window.__app.settings.dimensions,
    };
  });

  expect(state.canvases, 'one board, not two').toBe(1);
  // What is mounted and what the settings claim must agree.
  expect(state.mounted).toBe(state.setting);
  expect(errors).toEqual([]);
});
