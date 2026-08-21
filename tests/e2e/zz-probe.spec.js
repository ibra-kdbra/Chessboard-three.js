import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* private mode */ }
  });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 60_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 60_000 });
}

const press = (page, key) =>
  page.evaluate((k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }, key);

test('PROBE 1: post-game review hangs after analysis completes', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async () => {
    const app = window.__app;
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) app.session.state.move(san);
    // Stand in for the real analyser so the probe measures the dialog, not lozza.
    app.analyser.start = async () => {};
    app.analyser.reviewLine = async (nodes, { onProgress }) => {
      onProgress?.(nodes.length, nodes.length);
      return true;
    };
    const done = app.actions.review();
    await new Promise((r) => setTimeout(r, 1500));
    return {
      finished: await Promise.race([done.then(() => 'RESOLVED'), Promise.resolve('PENDING')]),
      dialogsInDom: [...document.querySelectorAll('dialog.dialog')].map((d) => ({
        title: d.querySelector('.dialog__title')?.textContent,
        open: d.open,
      })),
      summaryShown: Boolean(document.querySelector('dialog[open] .review')),
    };
  });
  console.log('PROBE1', JSON.stringify(out, null, 2));
  expect(out.summaryShown).toBe(false);
});

test('PROBE 2: global shortcuts act on the game behind an open modal', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    for (const san of ['e4', 'e5', 'Nf3']) window.__app.session.state.move(san);
    window.__app.session.state.toEnd();
  });
  const before = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    orientation: window.__app.board.orientation(),
  }));

  // Open the New game dialog and put focus inside it, as a keyboard user would.
  await page.evaluate(() => window.__app.actions.newGame());
  await page.waitForSelector('dialog[open]');
  await page.evaluate(() => document.querySelector('dialog[open] .dialog__foot button').focus());

  const focusedTag = await page.evaluate(() => document.activeElement.tagName);
  await press(page, 'ArrowLeft');
  await press(page, 'f');
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    orientation: window.__app.board.orientation(),
    dialogStillOpen: Boolean(document.querySelector('dialog[open]')),
  }));
  console.log('PROBE2', JSON.stringify({ focusedTag, before, after }, null, 2));
  expect(after.dialogStillOpen).toBe(true);
  expect(after.ply).not.toBe(before.ply); // ArrowLeft navigated behind the modal
  expect(after.orientation).not.toBe(before.orientation); // 'f' flipped behind it
});

test('PROBE 3: typing a move with an f- or h-file letter triggers a shortcut instead', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => ({
    orientation: window.__app.board.orientation(),
    ply: window.__app.session.state.ply,
    typed: window.__app.keyboard.typed,
  }));
  for (const k of ['N', 'f', '3']) await press(page, k);
  const mid = await page.evaluate(() => ({
    typed: window.__app.keyboard.typed,
    orientation: window.__app.board.orientation(),
  }));
  await press(page, 'Enter');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    ply: window.__app.session.state.ply,
    typed: window.__app.keyboard.typed,
    orientation: window.__app.board.orientation(),
    status: document.querySelector('.status')?.textContent,
  }));
  console.log('PROBE3', JSON.stringify({ before, mid, after }, null, 2));
  expect(mid.typed).toBe('N3'); // the 'f' never reached the buffer
  expect(mid.orientation).not.toBe(before.orientation); // it flipped the board
  expect(after.ply).toBe(0); // no move was played
});

test('PROBE 4: takeback as Black leaves nobody to move', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async () => {
    const app = window.__app;
    await app.session.newGame({ color: 'b' });
    await new Promise((r) => setTimeout(r, 200));
    const afterOpen = {
      ply: app.session.state.ply,
      turn: app.session.state.turn,
      thinking: app.session.thinking,
    };
    await app.actions.takeback();
    const afterTakeback = {
      ply: app.session.state.ply,
      turn: app.session.state.turn,
      isPlayerTurn: app.session.isPlayerTurn,
      thinking: app.session.thinking,
      status: document.querySelector('.status')?.textContent,
    };
    // Try to play as Black, the only side the human controls.
    const played = await app.session.play({ from: 'e7', to: 'e5' });
    return { afterOpen, afterTakeback, playedAfter: played, plyNow: app.session.state.ply };
  });
  console.log('PROBE4', JSON.stringify(out, null, 2));
  expect(out.afterTakeback.turn).toBe('w');
  expect(out.afterTakeback.isPlayerTurn).toBe(false);
  expect(out.playedAfter).toBeNull();
});
