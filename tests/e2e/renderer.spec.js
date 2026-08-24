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

test('the board runs the quality tier the device probe chose', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  const quality = await page.evaluate(() => ({
    config: window.__board.config.quality,
    view: window.__board.view.quality,
  }));

  // The probe's answer used to be discarded: `{ quality: undefined }` from the
  // caller was spread over the computed default, so every device rendered at
  // 'high' and the frame budget could never step down from a tier it could not
  // name in QUALITY_ORDER.
  expect(['low', 'medium', 'high', 'ultra']).toContain(quality.config);
  expect(quality.view).toBe(quality.config);
  expect(errors).toEqual([]);
});

test('a static scene renders the same pixels every frame', async ({ page }) => {
  const errors = [];
  guardConsole(page, errors);
  await page.goto('/sandbox.html');
  await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

  // Force four renders of an unchanged scene and compare them pairwise. An
  // alias that left the composer's read buffer pointing at a stale target made
  // every second frame render at 300x150 and upscale — invisible to a
  // screenshot test, which only ever samples one parity, and invisible to a
  // pixel-count test, which would still see plenty of colours.
  const frames = await page.evaluate(() => {
    const board = window.__board;
    const gl = board.view.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const shots = [];
    for (let i = 0; i < 4; i++) {
      board.view.render();
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // Hash rather than ship four framebuffers across the bridge.
      let hash = 2166136261;
      for (let p = 0; p < pixels.length; p += 97) {
        hash = Math.imul(hash ^ pixels[p], 16777619) >>> 0;
      }
      shots.push(hash);
    }
    return { shots, width, height };
  });

  expect(frames.width).toBeGreaterThan(300);
  // All four identical: nothing moved, so nothing may change.
  expect(new Set(frames.shots).size, `frame hashes ${frames.shots.join(', ')}`).toBe(1);
  expect(errors).toEqual([]);
});

/**
 * Where the board actually lands on the canvas it is drawn on.
 *
 * Projects the eight corners of the board's bounding box by hand rather than
 * through three.js, so the measurement does not depend on the page exposing a
 * module it otherwise has no reason to.
 */
const measureBoard = (page) =>
  page.evaluate(() => {
    const camera = window.__app.board.view.camera;
    camera.updateMatrixWorld(true);
    const mul = (m, v) => {
      const e = m.elements;
      return [
        e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12] * v[3],
        e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13] * v[3],
        e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14] * v[3],
        e[3] * v[0] + e[7] * v[1] + e[11] * v[2] + e[15] * v[3],
      ];
    };
    const R = 10.3;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const x of [-R, R]) {
      for (const z of [-R, R]) {
        for (const y of [0, 3.2]) {
          const c = mul(camera.projectionMatrix, mul(camera.matrixWorldInverse, [x, y, z, 1]));
          minX = Math.min(minX, c[0] / c[3]);
          maxX = Math.max(maxX, c[0] / c[3]);
          minY = Math.min(minY, c[1] / c[3]);
          maxY = Math.max(maxY, c[1] / c[3]);
        }
      }
    }
    const canvas = document.querySelector('#board canvas').getBoundingClientRect();
    const bar = document.querySelector('.evalbar').getBoundingClientRect();
    const width = (maxX - minX) / 2;
    const height = (maxY - minY) / 2;
    return {
      width,
      height,
      drawnWidth: Math.round(width * canvas.width),
      drawnHeight: Math.round(height * canvas.height),
      // Blank canvas between the evaluation bar and the edge of the board.
      gap: Math.round(canvas.left + ((minX + 1) / 2) * canvas.width - bar.right),
    };
  });

/**
 * Resizes, then waits for the board to have actually reframed for the new box.
 *
 * Headless Chromium produces no frames while nothing is animating, and a
 * ResizeObserver is only delivered as part of a frame. Without forcing one the
 * camera is still framed for the previous viewport, and every number measured
 * afterwards describes the wrong thing.
 */
const settle = async (page, width, height) => {
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: 'test-results/shots/framing-settle.png' });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('#board canvas').getBoundingClientRect();
      return Math.abs(window.__app.board.view.camera.aspect - canvas.width / canvas.height) < 0.01;
    },
    { timeout: 20_000 },
  );
};

const bootApp = async (page) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });
};

test('the board fills the box a phone reserves for it', async ({ page }) => {
  await bootApp(page);

  await settle(page, 390, 844);
  const phone = await measureBoard(page);
  // A square box held a board that drew two thirds of it: 122px of empty table
  // above and below on a 390px screen, which reads as a small board rather than
  // as framing. The box is the shape the board projects to now, and the flatter
  // tilt a small screen gets makes the board bigger inside it rather than
  // smaller.
  expect(phone.height, 'the board must fill the height a phone reserves').toBeGreaterThan(0.85);
  expect(phone.width).toBeGreaterThan(0.9);
  expect(phone.drawnHeight, 'and be bigger than the square box drew').toBeGreaterThan(280);

  // The desktop composition is deliberate and must not move: the view only tips
  // downward for screens too small to read a board at the resting angle.
  await settle(page, 1440, 900);
  const desktop = await measureBoard(page);
  expect(desktop.width).toBeGreaterThan(0.95);
  expect(desktop.height).toBeGreaterThan(0.78);
  expect(desktop.height).toBeLessThan(0.83);
});

test('the evaluation bar stays beside the board it measures', async ({ page }) => {
  await bootApp(page);

  // Wide, short stages are where this went wrong: the board is limited by the
  // height it is given, so the leftover width was dead canvas — the board
  // floating in the middle of it and the bar pinned to the far left, 134px away
  // at 900x800 and worse below that.
  for (const [width, height] of [
    [900, 800],
    [860, 700],
    [768, 1024],
    [700, 900],
    [660, 500],
    [1440, 900],
    [390, 844],
  ]) {
    await settle(page, width, height);
    const board = await measureBoard(page);
    expect(board.gap, `evaluation bar stranded at ${width}x${height}`).toBeLessThanOrEqual(24);
    // Trimming the canvas must never trim the board with it.
    expect(board.width, `board shrank at ${width}x${height}`).toBeGreaterThan(0.75);
    expect(board.height, `board shrank at ${width}x${height}`).toBeGreaterThan(0.6);
  }
});
