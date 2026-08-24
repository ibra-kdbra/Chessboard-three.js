import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text());
});
await page.goto('http://127.0.0.1:8080/index.html');
await page.waitForFunction(() => window.__appReady === true, { timeout: 45000 });
await page.waitForFunction(() => window.__app?.board?.ready === true, { timeout: 45000 });
await page.evaluate(async () => {
  for (const san of [
    'e4',
    'c5',
    'Nf3',
    'd6',
    'd4',
    'cxd4',
    'Nxd4',
    'Nf6',
    'Nc3',
    'a6',
    'Be3',
    'e5',
  ]) {
    window.__app.session.state.move(san);
  }
  window.__app.session.state.tree.current.evaluation = { type: 'cp', value: 42 };
  window.__app.session.emit('status', window.__app.session.status());
  window.__app.actions.end();
});
await page.waitForFunction(() => window.__app.board.ticker.active === false, { timeout: 30000 });
await page.screenshot({
  path: '/home/user/Chessboard-three.js/test-results/shots/app-desktop.png',
});
console.log('ok');
await browser.close();
