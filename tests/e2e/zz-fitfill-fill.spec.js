import { test, expect } from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/zz-fitfill.txt';
const BASE = 'http://127.0.0.1:8154/index.html';
const log = (s) => appendFileSync(OUT, s + '\n');

const SIZES = [
  { name: '1440x900', w: 1440, h: 900 },
  { name: '1280x800', w: 1280, h: 800 },
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1024x768', w: 1024, h: 768 },
  { name: 'pixel7 412x915', w: 412, h: 915 },
];

test.beforeAll(() => writeFileSync(OUT, '=== fit/fill measurement ===\n'));

test('measure board fill', async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__app?.board?.ready === true, null, { timeout: 60000 });
    await page.waitForTimeout(600);

    const data = await page.evaluate(async () => {
      const THREE = await import('three');
      const app = window.__app;
      const view = app.board.view;
      const cam = view.camera;
      view.render();
      cam.updateMatrixWorld(true);

      const host = document.getElementById('board');
      const canvas = host.querySelector('canvas');
      const cr = canvas.getBoundingClientRect();
      const W = cr.width, H = cr.height;

      const toPx = (v3) => {
        const p = v3.clone().project(cam);
        return { x: (p.x * 0.5 + 0.5) * W, y: (1 - (p.y * 0.5 + 0.5)) * H };
      };

      // --- board quad, using the module's own BOARD_RADIUS silhouette ---
      const R = 10.3;
      const quadOrder = [
        new THREE.Vector3(-R, 0, -R),
        new THREE.Vector3(R, 0, -R),
        new THREE.Vector3(R, 0, R),
        new THREE.Vector3(-R, 0, R),
      ].map(toPx);
      let area = 0;
      for (let i = 0; i < 4; i++) {
        const a = quadOrder[i], b = quadOrder[(i + 1) % 4];
        area += a.x * b.y - b.x * a.y;
      }
      area = Math.abs(area) / 2;

      const xs = quadOrder.map((p) => p.x), ys = quadOrder.map((p) => p.y);
      const margins = {
        left: Math.min(...xs),
        right: W - Math.max(...xs),
        top: Math.min(...ys),
        bottom: H - Math.max(...ys),
      };

      // --- true rendered silhouette of board group + pieces, in px ---
      const bboxPx = (obj) => {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return null;
        const pts = [];
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) pts.push(toPx(new THREE.Vector3(x, y, z)));
        return {
          minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
          minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
          box: { min: box.min.toArray().map((n) => +n.toFixed(2)), max: box.max.toArray().map((n) => +n.toFixed(2)) },
        };
      };

      // --- which silhouette corner actually binds at the fitted distance ---
      const corners = [];
      for (const x of [-R, R]) for (const z of [-R, R]) for (const y of [0, 3.2]) corners.push({ x, y, z });
      const projected = corners.map((c) => {
        const p = new THREE.Vector3(c.x, c.y, c.z).project(cam);
        return { c, nx: p.x, ny: p.y };
      });
      const worstX = Math.max(...projected.map((p) => Math.abs(p.nx)));
      const worstY = Math.max(...projected.map((p) => Math.abs(p.ny)));
      const binder = projected.reduce((best, p) =>
        Math.max(Math.abs(p.nx), Math.abs(p.ny)) > Math.max(Math.abs(best.nx), Math.abs(best.ny)) ? p : best);

      // --- counterfactual: same fit with zero headroom ---
      const fit = (probe, headroom, margin = 1.02) => {
        const cs = [];
        for (const x of [-R, R]) for (const z of [-R, R])
          for (const y of headroom === 0 ? [0] : [0, headroom]) cs.push(new THREE.Vector3(x, y, z));
        const target = new THREE.Vector3(0, -0.6, 0);
        const dir = probe.position.clone().sub(target);
        let dist = dir.length();
        dir.normalize();
        for (let i = 0; i < 6; i++) {
          probe.position.copy(target).addScaledVector(dir, dist);
          probe.lookAt(target); probe.updateMatrixWorld(true); probe.updateProjectionMatrix();
          let worst = 0;
          for (const c of cs) { const p = c.clone().project(probe); worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y)); }
          if (worst <= 0.0001) break;
          const scale = worst * margin;
          if (Math.abs(scale - 1) < 0.005) break;
          dist *= scale;
        }
        probe.position.copy(target).addScaledVector(dir, dist);
        probe.lookAt(target); probe.updateMatrixWorld(true); probe.updateProjectionMatrix();
        return dist;
      };
      const areaFor = (c) => {
        const q = [
          new THREE.Vector3(-R, 0, -R), new THREE.Vector3(R, 0, -R),
          new THREE.Vector3(R, 0, R), new THREE.Vector3(-R, 0, R),
        ].map((v) => { const p = v.clone().project(c); return { x: (p.x*0.5+0.5)*W, y: (1-(p.y*0.5+0.5))*H }; });
        let a = 0;
        for (let i = 0; i < 4; i++) { const p1=q[i], p2=q[(i+1)%4]; a += p1.x*p2.y - p2.x*p1.y; }
        return { area: Math.abs(a)/2, q };
      };
      const probeA = cam.clone(); probeA.aspect = cam.aspect; probeA.updateProjectionMatrix();
      const dist32 = fit(probeA, 3.2);
      const a32 = areaFor(probeA);
      const probeB = cam.clone(); probeB.aspect = cam.aspect; probeB.updateProjectionMatrix();
      const dist0 = fit(probeB, 0);
      const a0 = areaFor(probeB);

      // square-canvas counterfactual: same height, width = height
      const S = Math.min(W, H);
      const probeC = cam.clone(); probeC.aspect = 1; probeC.updateProjectionMatrix();
      const distSq = fit(probeC, 3.2);
      const qSq = [
        new THREE.Vector3(-R, 0, -R), new THREE.Vector3(R, 0, -R),
        new THREE.Vector3(R, 0, R), new THREE.Vector3(-R, 0, R),
      ].map((v) => { const p = v.clone().project(probeC); return { x:(p.x*0.5+0.5)*S, y:(1-(p.y*0.5+0.5))*S }; });
      let aSq = 0;
      for (let i = 0; i < 4; i++) { const p1=qSq[i], p2=qSq[(i+1)%4]; aSq += p1.x*p2.y - p2.x*p1.y; }
      aSq = Math.abs(aSq)/2;

      const stage = document.querySelector('.stage')?.getBoundingClientRect();
      const frame = document.querySelector('.stage__frame')?.getBoundingClientRect();
      const evalbar = document.querySelector('.evalbar')?.getBoundingClientRect();
      const panel = document.querySelector('.panel')?.getBoundingClientRect();

      return {
        dpr: window.devicePixelRatio,
        canvas: { w: +W.toFixed(1), h: +H.toFixed(1), aspect: +(W / H).toFixed(3) },
        drawingBuffer: { w: canvas.width, h: canvas.height },
        stage: stage && { w: +stage.width.toFixed(1), h: +stage.height.toFixed(1) },
        frame: frame && { w: +frame.width.toFixed(1), h: +frame.height.toFixed(1) },
        evalbar: evalbar && { w: +evalbar.width.toFixed(1), h: +evalbar.height.toFixed(1) },
        panel: panel && { w: +panel.width.toFixed(1), h: +panel.height.toFixed(1) },
        boardQuadPx: quadOrder.map((p) => [Math.round(p.x), Math.round(p.y)]),
        boardArea: Math.round(area),
        canvasArea: Math.round(W * H),
        fillPct: +((area / (W * H)) * 100).toFixed(1),
        margins: Object.fromEntries(Object.entries(margins).map(([k, v]) => [k, Math.round(v)])),
        boardGroupPx: bboxPx(app.board.board.group),
        piecesPx: bboxPx(app.board.pieceGroup),
        cam: {
          fov: cam.fov, aspect: +cam.aspect.toFixed(3),
          pos: cam.position.toArray().map((n) => +n.toFixed(2)),
          distance: +cam.position.clone().sub(new THREE.Vector3(0, -0.6, 0)).length().toFixed(2),
          fittedDistance: +(view.fittedDistance ?? 0).toFixed(2),
        },
        bind: { worstX: +worstX.toFixed(4), worstY: +worstY.toFixed(4), binder: binder.c, binderNdc: [+binder.nx.toFixed(3), +binder.ny.toFixed(3)] },
        counterfactual: {
          headroom3_2: { dist: +dist32.toFixed(2), areaPx: Math.round(a32.area), fillPct: +((a32.area/(W*H))*100).toFixed(1) },
          headroom0:   { dist: +dist0.toFixed(2),  areaPx: Math.round(a0.area),  fillPct: +((a0.area/(W*H))*100).toFixed(1) },
          squareCanvas: { side: Math.round(S), dist: +distSq.toFixed(2), areaPx: Math.round(aSq), fillPct: +((aSq/(S*S))*100).toFixed(1) },
        },
      };
    });

    log('\n### ' + size.name);
    log(JSON.stringify(data, null, 2));
  }
  expect(true).toBe(true);
});
