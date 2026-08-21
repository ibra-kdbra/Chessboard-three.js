#!/usr/bin/env node
/**
 * Ad-hoc scene inspector. Boots the sandbox in a real browser and prints
 * whatever expression you hand it, evaluated in the page.
 *
 *   node tools/dev/inspect.mjs "window.__board.pieces.size"
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROMIUM = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
].filter(Boolean).find(existsSync);

const expression = process.argv[2] ?? 'window.__board.pieces.size';
const url = process.env.SANDBOX_URL ?? 'http://127.0.0.1:8080/sandbox.html';

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (error) => console.error('PAGEERROR', String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') console.error('CONSOLE', message.text());
});
await page.goto(url);
await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });
const result = await page.evaluate(`(() => { return (${expression}); })()`);
console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
await browser.close();
