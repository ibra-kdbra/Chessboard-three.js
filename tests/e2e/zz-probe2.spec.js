import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* private */ } });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 60_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 60_000 });
}

test('PROBE 4c: who plays the second e4?', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async () => {
    const app = window.__app;
    const log = [];
    const s = app.session;

    const origMaybe = s.maybePlayEngineMove.bind(s);
    let n = 0;
    s.maybePlayEngineMove = async function (...args) {
      const id = ++n;
      log.push([`maybePlayEngineMove#${id} ENTER`, s.state.ply, s.state.turn, 'thinking=' + s.thinking, new Error().stack.split('\n')[2]?.trim()]);
      const r = await origMaybe(...args);
      log.push([`maybePlayEngineMove#${id} EXIT`, r?.san ?? null, s.state.ply]);
      return r;
    };

    await s.newGame({ color: 'b' });
    log.push(['after newGame', s.state.ply, s.state.turn, s.thinking]);
    await new Promise((r) => setTimeout(r, 400));
    log.push(['settled', s.state.ply, s.state.turn, s.thinking]);

    const origMove = s.state.move.bind(s.state);
    s.state.move = function (m, o) {
      log.push(['state.move', JSON.stringify(m), new Error().stack.split('\n').slice(2, 5).map((x) => x.trim())]);
      return origMove(m, o);
    };

    await s.takeback();
    log.push(['after takeback', s.state.ply, s.state.turn, s.thinking]);
    return log;
  });
  console.log('PROBE4c\n' + out.map((r) => JSON.stringify(r)).join('\n'));
});
