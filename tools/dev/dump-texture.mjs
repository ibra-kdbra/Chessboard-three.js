#!/usr/bin/env node
/**
 * Saves a procedural texture to a PNG so it can be judged on its own, without
 * lighting, geometry and tone mapping in the way.
 *
 *   node tools/dev/dump-texture.mjs wood '{"rings":22,"turbulence":0.7}' out.png
 */
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROMIUM = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium'].find(
  existsSync,
);
const [kind = 'wood', optionsJson = '{}', out = 'texture.png'] = process.argv.slice(2);

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('PAGEERROR', String(error)));
await page.goto('http://127.0.0.1:8080/sandbox.html');
await page.waitForFunction(() => window.__sandboxReady === true, { timeout: 30_000 });

const dataUrl = await page.evaluate(
  async ([textureKind, options]) => {
    const module = await import('/src/render/three/textures.js');
    const builders = {
      wood: module.woodTexture,
      marble: module.marbleTexture,
      roughness: module.roughnessTexture,
    };
    const texture = builders[textureKind](options);
    const source = texture.image;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    return canvas.toDataURL('image/png');
  },
  [kind, JSON.parse(optionsJson)],
);

writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log(`wrote ${out}`);
await browser.close();
