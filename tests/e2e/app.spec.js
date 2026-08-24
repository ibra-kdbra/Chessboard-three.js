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

/**
 * Waits for the page to finish reacting to a viewport change.
 *
 * The board canvas is resized by an observer on the frame after the viewport
 * moves, and the header re-lays-out on the resize event, so measuring in the
 * same tick reads the page mid-reflow. Waiting for the width to hold still for
 * two frames is both faster and steadier than guessing at a delay.
 */
async function reflowed(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const read = () => document.documentElement.scrollWidth;
        const first = read();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve(first === read());
          }),
        );
      }),
    { timeout: 15_000 },
  );
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
  // The saved moves must survive. Not an exact match: it is the computer's turn
  // in this position, and a restored game prompts it — so play legitimately
  // continues past what was saved.
  const moves = (pgn) =>
    pgn
      .split(/\n\n/)
      .pop()
      .trim()
      .replace(/\s+\*$/, '');
  expect(moves(after).startsWith(moves(before))).toBe(true);
  expect(moves(before).length).toBeGreaterThan(0);
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

test('the evaluation bar tracks the position while you think', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  // A position where white is a queen up: the bar must swing well past level.
  await page.evaluate(() => {
    window.__app.session.loadState({
      version: 1,
      startFen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      tree: {
        version: 1,
        startFen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        headers: {},
        children: [],
      },
    });
    window.__app.analyser.analyse(window.__app.session.state.fen, { turn: 'w' });
  });

  // The fill is scaled rather than resized, so the share is the scaleY factor.
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('.evalbar__white');
      if (!bar) return false;
      const match = /scaleY\(([\d.]+)\)/.exec(bar.style.transform);
      return match ? Number(match[1]) > 0.7 : false;
    },
    { timeout: 45_000 },
  );

  const reading = await page.evaluate(() => {
    const bar = document.querySelector('.evalbar__white');
    const match = /scaleY\(([\d.]+)\)/.exec(bar.style.transform);
    return {
      share: match ? Number(match[1]) : 0,
      label: document.querySelector('.evalbar__value').textContent,
      aria: document.querySelector('.evalbar').getAttribute('aria-valuetext'),
    };
  });
  expect(reading.share).toBeGreaterThan(0.7);
  expect(reading.aria).toContain('White');
  expect(errors).toEqual([]);
});

test('resign ends the game and offers a rematch', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await page.evaluate(() => window.__app.session.state.move('e4'));
  // Deliberately not awaited: the action's promise only settles once the
  // confirmation dialog is answered, which happens on the next line.
  await page.evaluate(() => {
    window.__app.actions.resign();
  });
  await page.locator('.dialog__foot .button--danger').click();

  await expect(page.locator('.dialog__title')).toContainText('Black wins');
  expect(await page.evaluate(() => window.__app.session.state.result().reason)).toBe('resignation');
  expect(errors).toEqual([]);
});

test('a game round-trips through a share link', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await page.evaluate(() => {
    for (const san of ['d4', 'd5', 'c4', 'e6']) window.__app.session.state.move(san);
  });
  const url = await page.evaluate(async () => {
    const { buildShareUrl } = await import('/src/app/share.js');
    return buildShareUrl({ pgn: window.__app.session.state.pgn() });
  });
  expect(url).toContain('#game=');

  // Navigating to a URL that differs only by its fragment is a same-document
  // navigation — the page does not reload and bootstrap never re-runs. The
  // reload is what actually exercises the share path.
  await page.goto(url);
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45_000 });

  const loaded = await page.evaluate(() => ({
    moves: window.__app.session.state.tree.mainline().map((n) => n.move.san),
    mode: window.__app.session.mode,
    hash: window.location.hash,
  }));
  expect(loaded.moves).toEqual(['d4', 'd5', 'c4', 'e6']);
  // Analysis mode, so the visitor can play either side from the shared position.
  expect(loaded.mode).toBe('analysis');
  // The fragment is cleared so a reload does not re-import over their own game.
  expect(loaded.hash).toBe('');
  expect(errors).toEqual([]);
});

test('a finished game can be analysed and graphed', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  guard(page, errors);
  await boot(page);

  // A short decisive game, so the review has something to say.
  await page.evaluate(() => {
    for (const san of ['e4', 'e5', 'Bc4', 'Bc5', 'Qh5', 'Nf6', 'Qxf7#']) {
      window.__app.session.state.move(san);
    }
    window.__app.actions.end();
  });

  // Not awaited: the action settles only once the summary dialog is dismissed.
  await page.evaluate(() => {
    window.__app.actions.review();
  });
  await page.waitForFunction(() => document.querySelector('.evalgraph') !== null, {
    timeout: 90_000,
  });

  const outcome = await page.evaluate(() => {
    const nodes = window.__app.session.state.tree.mainline();
    return {
      scored: nodes.filter((node) => node.evaluation).length,
      total: nodes.length,
      graded: nodes.filter((node) => node.quality).length,
      graphPaths: document.querySelectorAll('.evalgraph path').length,
    };
  });

  // Every position in the line must carry a score after the pass.
  expect(outcome.scored).toBe(outcome.total);
  expect(outcome.graded).toBeGreaterThan(0);
  expect(outcome.graphPaths).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: 'test-results/shots/app-review.png' });
  expect(errors).toEqual([]);
});

test('typing a move containing f, h or t enters it rather than firing a shortcut', async ({
  page,
}) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  const before = await page.evaluate(() => window.__app.board.orientation());
  await page.locator('#board').focus();
  // `f` and `h` are file letters. Bound plainly as shortcuts, this flips the
  // board and never reaches the move buffer.
  await page.keyboard.type('Nf3');
  await page.keyboard.press('Enter');

  await page.waitForFunction(() => window.__app.session.state.ply >= 1, { timeout: 20_000 });
  const after = await page.evaluate(() => ({
    first: window.__app.session.state.tree.mainline()[0].move.san,
    orientation: window.__app.board.orientation(),
  }));

  expect(after.first).toBe('Nf3');
  expect(after.orientation).toBe(before);
  expect(errors).toEqual([]);
});

test('shortcuts do not reach the game behind an open dialog', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  await page.evaluate(() => {
    for (const san of ['e4', 'e5', 'Nf3']) window.__app.session.state.move(san);
    window.__app.actions.end();
  });
  const before = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    orientation: window.__app.board.orientation(),
  }));

  await page.evaluate(() => {
    window.__app.actions.newGame();
  });
  await page.waitForSelector('dialog[open]');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+F');
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    orientation: window.__app.board.orientation(),
    dialogOpen: document.querySelector('dialog[open]') !== null,
  }));

  // The dialog owns the keyboard while it is up.
  expect(after.dialogOpen).toBe(true);
  expect(after.ply).toBe(before.ply);
  expect(after.orientation).toBe(before.orientation);
  expect(errors).toEqual([]);
});

test('the star prompt is earned, asks once, and takes no for an answer', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
  });
  await page.reload();
  await boot(page);

  const shown = () =>
    page.evaluate(() => {
      const node = document.querySelector('.starprompt');
      return node ? !node.hidden : 'missing';
    });
  const ask = () => page.evaluate(() => window.__app.maybeAskForAStar());
  const finish = (count) =>
    page.evaluate((n) => {
      for (let i = 0; i < n; i++) window.__app.store.addToLibrary({ pgn: `g${i}`, result: '1-0' });
    }, count);

  // Nothing on arrival, and nothing before it has been earned.
  expect(await shown()).toBe(false);
  await finish(2);
  await ask();
  expect(await shown(), 'two games is not enough to have an opinion').toBe(false);

  await finish(1);
  await ask();
  expect(await shown()).toBe(true);

  // Declining is a real answer, and it sticks — this session and the next.
  await page.click('.starprompt button');
  expect(await shown()).toBe(false);
  await ask();
  expect(await shown()).toBe(false);

  await page.reload();
  await boot(page);
  await ask();
  expect(await shown(), 'a declined ask must not come back after a reload').toBe(false);
  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
});

test('the match band lights whoever is to move, on a clock that never runs', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  const lit = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.matchrow')]
        .filter((row) => row.dataset.active === 'true')
        .map((row) => row.querySelector('.matchrow__name').textContent),
    );

  // The default time control is unlimited, so the clock never starts. Reading
  // the highlight from whichever clock was running meant that on the settings
  // most people play with, neither row ever lit up.
  expect(await lit()).toEqual(['White']);

  await page.evaluate(() => {
    window.__app.session.state.move('e4');
    window.__app.session.emit('status', window.__app.session.status());
  });
  expect(await lit()).toEqual(['Black']);

  // A finished game has no side to move, and a row still glowing after mate
  // reads as "your turn".
  await page.evaluate(() => {
    for (const san of ['e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) {
      window.__app.session.state.move(san);
    }
    window.__app.session.emit('status', window.__app.session.status());
  });
  expect(await lit()).toEqual([]);
  expect(errors).toEqual([]);
});

test('the header fits every screen it claims to support', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  for (const width of [1440, 1100, 960, 901, 899, 700, 640, 480, 420, 380, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await reflowed(page);
    const measured = await page.evaluate(() => {
      const controls = [
        ...document.querySelectorAll(
          '.topbar__identity > *, .topbar__nav > *, .topbar__actions > *, .topbar__utilities > *',
        ),
      ].map((node) => node.getBoundingClientRect());
      let overlap = 0;
      for (let i = 1; i < controls.length; i += 1) {
        overlap = Math.max(overlap, controls[i - 1].right - controls[i].left);
      }
      const doc = document.documentElement;
      return {
        overlap,
        pageOverflow: doc.scrollWidth - doc.clientWidth,
        // Touch targets, ignoring the wordmark, which is text and not one.
        undersized: controls.filter((r) => r.height > 0 && r.height < 43.5).length - 1,
      };
    });
    // Seven controls and a wordmark needed 409px of row; at 380 the whole page
    // scrolled sideways, and between 901 and 1037px the icons were drawn on
    // top of "New game".
    expect(measured.overlap, `controls overlap at ${width}px`).toBeLessThanOrEqual(0);
    expect(measured.pageOverflow, `page scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
    expect(measured.undersized, `targets under 44px at ${width}px`).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test('the overflow menu opens under the button that opens it', async ({ page }) => {
  const errors = [];
  guard(page, errors);
  await boot(page);

  for (const width of [1440, 900, 380]) {
    await page.setViewportSize({ width, height: 800 });
    await reflowed(page);
    await page.click('[popovertarget="topbar-more"]');
    const placed = await page.evaluate(() => {
      const menu = document.getElementById('topbar-more').getBoundingClientRect();
      const trigger = document
        .querySelector('[popovertarget="topbar-more"]')
        .getBoundingClientRect();
      return {
        rightAligned: Math.abs(menu.right - trigger.right) <= 2,
        below: menu.top >= trigger.bottom,
        onScreen:
          menu.left >= 0 && menu.right <= window.innerWidth && menu.bottom <= window.innerHeight,
        items: document.querySelectorAll('#topbar-more > *').length,
      };
    });
    // The top layer has no idea where the trigger is; an unanchored popover
    // lands in the corner of the window, over the wordmark.
    expect(placed, `menu placement at ${width}px`).toMatchObject({
      rightAligned: true,
      below: true,
      onScreen: true,
    });
    // Narrow screens demote controls into it rather than letting the row run
    // off the edge, so it never comes back empty.
    expect(placed.items).toBeGreaterThanOrEqual(4);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});
