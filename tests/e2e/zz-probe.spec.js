import { test, expect } from '@playwright/test';

test.describe('PROBE dialog', () => {
  test('external close leaves the promise pending and the node in the DOM', async ({ page }) => {
    await page.goto('/index.html');
    const out = await page.evaluate(async () => {
      const { showDialog } = await import('/src/ui/dialog.js');
      const res = {};

      const p1 = showDialog({ title: 'A', actions: [{ label: 'OK', value: 'ok' }] });
      document.querySelector('dialog.dialog .dialog__foot button').click();
      res.buttonClose = await Promise.race([
        p1,
        new Promise((r) => setTimeout(() => r('TIMEOUT'), 300)),
      ]);
      res.nodesAfterButtonClose = document.querySelectorAll('dialog.dialog').length;

      // Exactly what main.js runPostGameReview does to end the progress dialog.
      const p2 = showDialog({
        title: 'Game review',
        actions: [{ label: 'Stop', value: 'stop' }],
        dismissible: false,
      });
      document.querySelector('dialog[open]').close();
      res.externalClose = await Promise.race([
        p2,
        new Promise((r) => setTimeout(() => r('NEVER SETTLED'), 800)),
      ]);
      res.nodesAfterExternalClose = document.querySelectorAll('dialog.dialog').length;
      res.leftInDom = [...document.querySelectorAll('dialog.dialog')].map((d) => ({
        title: d.querySelector('.dialog__title')?.textContent,
        open: d.open,
      }));
      return res;
    });
    console.log(JSON.stringify(out, null, 2));
    expect(out.externalClose).toBe('NEVER SETTLED');
  });
});
