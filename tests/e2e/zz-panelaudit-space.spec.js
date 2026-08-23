import { test, expect } from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/panelaudit.txt';
const BASE = 'http://127.0.0.1:8137';
const PGN =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7';

const SIZES = [
  [1440, 900],
  [1280, 800],
  [1100, 760],
  [1024, 768],
];

function log(s) {
  appendFileSync(OUT, s + '\n');
}

async function boot(page) {
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true, { timeout: 60_000 });
  await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 60_000 });
}

const MEASURE = () => {
  const h = (sel) => {
    const n = document.querySelector(sel);
    return n ? Math.round(n.getBoundingClientRect().height * 10) / 10 : null;
  };
  const panel = document.querySelector('.panel');
  const fixed = document.querySelector('.panel__fixed');
  const sections = [...fixed.children].map((n) => ({
    cls: n.className,
    h: Math.round(n.getBoundingClientRect().height * 10) / 10,
    text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
  }));
  const clocks = document.querySelector('.panel__clocks');
  const trays = [...document.querySelectorAll('.panel__clocks .tray')].map((n) => ({
    nested: !!n.querySelector('.tray'),
    h: Math.round(n.getBoundingClientRect().height * 10) / 10,
    empty: n.textContent.trim() === '',
  }));
  const clockEls = [...document.querySelectorAll('.panel__clocks .clock')].map((n) => ({
    untimed: n.dataset.untimed,
    h: Math.round(n.getBoundingClientRect().height * 10) / 10,
    text: n.textContent.replace(/\s+/g, ' ').trim(),
    timeDisplay: getComputedStyle(n.querySelector('.clock__time')).display,
  }));
  const movelist = document.querySelector('.movelist');
  const mlRect = movelist.getBoundingClientRect();
  const moves = [...movelist.querySelectorAll('.movelist__move')];
  let fullyVisible = 0;
  for (const m of moves) {
    const r = m.getBoundingClientRect();
    if (r.top >= mlRect.top - 0.5 && r.bottom <= mlRect.bottom + 0.5) fullyVisible += 1;
  }
  const cur = movelist.querySelector('[aria-current="true"]');
  let currentMoveVisible = null;
  if (cur) {
    const r = cur.getBoundingClientRect();
    currentMoveVisible = r.top >= mlRect.top - 0.5 && r.bottom <= mlRect.bottom + 0.5;
  }
  return {
    panelH: h('.panel'),
    panelW: Math.round(panel.getBoundingClientRect().width),
    fixedH: h('.panel__fixed'),
    sections,
    clocksH: h('.panel__clocks'),
    clocksText: clocks.textContent.replace(/\s+/g, ' ').trim(),
    clockEls,
    trays,
    movesSectionH: h('.panel__moves'),
    movelistH: Math.round(mlRect.height * 10) / 10,
    movelistScrollH: movelist.scrollHeight,
    transportH: h('.transport'),
    assistH: h('.assist'),
    engineH: h('.engineinfo'),
    moveCount: moves.length,
    fullyVisible,
    currentMoveVisible,
  };
};

test('panel space audit', async ({ page }) => {
  writeFileSync(OUT, '');
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);

  for (const [w, hgt] of SIZES) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(400);

    const empty = await page.evaluate(MEASURE);
    log(`\n===== ${w}x${hgt} : EMPTY GAME =====`);
    log(JSON.stringify(empty, null, 1));

    await page.evaluate((pgn) => window.__app.session.loadPgn(pgn), PGN);
    await page.waitForFunction(
      () => document.querySelectorAll('.movelist__move').length >= 20,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(1200); // smooth scrollIntoView settle
    const played = await page.evaluate(MEASURE);
    log(`----- ${w}x${hgt} : 20 PLIES -----`);
    log(JSON.stringify(played, null, 1));
    log(
      `SHARES ${w}x${hgt}: fixed=${((played.fixedH / played.panelH) * 100).toFixed(1)}% ` +
        `movesSection=${((played.movesSectionH / played.panelH) * 100).toFixed(1)}% ` +
        `movelist=${((played.movelistH / played.panelH) * 100).toFixed(1)}% ` +
        `assist=${((played.assistH / played.panelH) * 100).toFixed(1)}% ` +
        `rowsFullyVisible=${played.fullyVisible}/${played.moveCount} ` +
        `currentVisible=${played.currentMoveVisible}`,
    );

    // Counterfactual: what does hiding untimed clocks alone buy?
    const cf = await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'cf-hide-untimed';
      s.textContent = `.panel__clocks { display: none }`;
      document.head.append(s);
      return null;
    });
    void cf;
    await page.waitForTimeout(200);
    const noClocks = await page.evaluate(MEASURE);
    log(
      `CF-hide-clocks ${w}x${hgt}: fixed=${noClocks.fixedH} movelist=${noClocks.movelistH} ` +
        `rowsFullyVisible=${noClocks.fullyVisible} movesShare=${((noClocks.movesSectionH / noClocks.panelH) * 100).toFixed(1)}%`,
    );
    await page.evaluate(() => document.getElementById('cf-hide-untimed')?.remove());
    await page.waitForTimeout(150);

    // Counterfactual: full proposed fix (clocks + status/opening + engine out of fixed)
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'cf-full';
      s.textContent = `.panel__fixed { display: none }`;
      document.head.append(s);
    });
    await page.waitForTimeout(200);
    const noFixed = await page.evaluate(MEASURE);
    log(
      `CF-hide-all-fixed ${w}x${hgt}: movelist=${noFixed.movelistH} ` +
        `rowsFullyVisible=${noFixed.fullyVisible} movesShare=${((noFixed.movesSectionH / noFixed.panelH) * 100).toFixed(1)}%`,
    );
    await page.evaluate(() => document.getElementById('cf-full')?.remove());
    await page.waitForTimeout(150);

    // reset to empty game for next size
    await page.evaluate(() => window.__app.session.newGame());
    await page.waitForTimeout(400);
  }
  expect(true).toBe(true);
});
