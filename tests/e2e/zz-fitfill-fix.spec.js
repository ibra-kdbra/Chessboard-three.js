import { test, expect } from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/zz-fitfix.txt';
const BASE = 'http://127.0.0.1:8154/index.html';
const log = (s) => appendFileSync(OUT, s + '\n');

const SIZES = [
  { name: '1440x900', w: 1440, h: 900 },
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1280x800', w: 1280, h: 800 },
];

const MEASURE = async () => {
  const THREE = await import('three');
  const view = window.__app.board.view;
  const cam = view.camera;
  view.render();
  cam.updateMatrixWorld(true);
  const canvas = document.getElementById('board').querySelector('canvas');
  const cr = canvas.getBoundingClientRect();
  const W = cr.width, H = cr.height;
  const toPx = (v) => { const p = v.clone().project(cam); return { x: (p.x*0.5+0.5)*W, y: (1-(p.y*0.5+0.5))*H }; };
  const R = 10.3;
  const q = [new THREE.Vector3(-R,0,-R), new THREE.Vector3(R,0,-R), new THREE.Vector3(R,0,R), new THREE.Vector3(-R,0,R)].map(toPx);
  let a = 0; for (let i=0;i<4;i++){const p1=q[i],p2=q[(i+1)%4]; a+=p1.x*p2.y-p2.x*p1.y;}
  a = Math.abs(a)/2;
  const geomTop = (() => {
    const b1 = new THREE.Box3().setFromObject(window.__app.board.board.group);
    const b2 = new THREE.Box3().setFromObject(window.__app.board.pieceGroup);
    const box = b1.clone(); if (!b2.isEmpty()) box.union(b2);
    const pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(toPx(new THREE.Vector3(x,y,z)));
    return { top: Math.min(...pts.map(p=>p.y)), bottom: Math.max(...pts.map(p=>p.y)), left: Math.min(...pts.map(p=>p.x)), right: Math.max(...pts.map(p=>p.x)) };
  })();
  return {
    canvas: { w: +W.toFixed(1), h: +H.toFixed(1) },
    boardAreaPx: Math.round(a),
    fillPct: +((a/(W*H))*100).toFixed(1),
    quadMargins: { top: Math.round(Math.min(...q.map(p=>p.y))), bottom: Math.round(H - Math.max(...q.map(p=>p.y))), left: Math.round(Math.min(...q.map(p=>p.x))), right: Math.round(W - Math.max(...q.map(p=>p.x))) },
    realGeomMargins: { top: Math.round(geomTop.top), bottom: Math.round(H - geomTop.bottom), left: Math.round(geomTop.left), right: Math.round(W - geomTop.right) },
    distance: +cam.position.clone().sub(new THREE.Vector3(0,-0.6,0)).length().toFixed(2),
  };
};

test.beforeAll(() => writeFileSync(OUT, '=== does the proposed fix help? ===\n'));

test('inject the proposed CSS and re-measure', async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__app?.board?.ready === true, null, { timeout: 60000 });
    await page.waitForTimeout(500);

    const base = await page.evaluate(MEASURE);

    await page.addStyleTag({ content: '.stage__frame { aspect-ratio: 1 / 1; margin-inline: auto; }' });
    await page.waitForTimeout(700);
    const squared = await page.evaluate(MEASURE);

    await page.addStyleTag({ content: '.stage { padding: var(--space-4) var(--space-4) var(--space-6); }' });
    await page.waitForTimeout(700);
    const squaredPadded = await page.evaluate(MEASURE);

    log('\n### ' + size.name);
    log('baseline        ' + JSON.stringify(base));
    log('aspect-ratio 1/1' + JSON.stringify(squared));
    log('  + asym padding' + JSON.stringify(squaredPadded));
    log('board px delta (squared vs base): ' + (((squared.boardAreaPx/base.boardAreaPx)-1)*100).toFixed(1) + '%');
    log('board px delta (squared+pad vs base): ' + (((squaredPadded.boardAreaPx/base.boardAreaPx)-1)*100).toFixed(1) + '%');
  }
  expect(true).toBe(true);
});

test('true-silhouette fit vs the shipped box fit', async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__app?.board?.ready === true, null, { timeout: 60000 });
    await page.waitForTimeout(500);

    const r = await page.evaluate(async () => {
      const THREE = await import('three');
      const view = window.__app.board.view;
      const cam = view.camera;
      view.render(); cam.updateMatrixWorld(true);
      const canvas = document.getElementById('board').querySelector('canvas');
      const cr = canvas.getBoundingClientRect();
      const W = cr.width, H = cr.height;
      const target = new THREE.Vector3(0, -0.6, 0);
      const R = 10.3, P = 7.95, PH = 3.2;

      const fit = (probe, corners, margin = 1.02) => {
        const dir = probe.position.clone().sub(target);
        let dist = dir.length(); dir.normalize();
        for (let i = 0; i < 6; i++) {
          probe.position.copy(target).addScaledVector(dir, dist);
          probe.lookAt(target); probe.updateMatrixWorld(true); probe.updateProjectionMatrix();
          let worst = 0;
          for (const c of corners) { const p = c.clone().project(probe); worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y)); }
          if (worst <= 0.0001) break;
          const s = worst * margin;
          if (Math.abs(s - 1) < 0.005) break;
          dist *= s;
        }
        probe.position.copy(target).addScaledVector(dir, dist);
        probe.lookAt(target); probe.updateMatrixWorld(true); probe.updateProjectionMatrix();
        return dist;
      };
      const report = (probe) => {
        const q = [new THREE.Vector3(-R,0,-R), new THREE.Vector3(R,0,-R), new THREE.Vector3(R,0,R), new THREE.Vector3(-R,0,R)]
          .map((v) => { const p = v.clone().project(probe); return { x:(p.x*0.5+0.5)*W, y:(1-(p.y*0.5+0.5))*H }; });
        let a=0; for(let i=0;i<4;i++){const p1=q[i],p2=q[(i+1)%4]; a+=p1.x*p2.y-p2.x*p1.y;}
        a = Math.abs(a)/2;
        // real geometry extents under this probe
        const b1 = new THREE.Box3().setFromObject(window.__app.board.board.group);
        const b2 = new THREE.Box3().setFromObject(window.__app.board.pieceGroup);
        const box = b1.clone(); if (!b2.isEmpty()) box.union(b2);
        const pts = [];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x,y,z).project(probe); pts.push({ x:(p.x*0.5+0.5)*W, y:(1-(p.y*0.5+0.5))*H });
        }
        const gTop = Math.min(...pts.map(p=>p.y)), gBot = Math.max(...pts.map(p=>p.y));
        const gL = Math.min(...pts.map(p=>p.x)), gR = Math.max(...pts.map(p=>p.x));
        return {
          areaPx: Math.round(a), fillPct: +((a/(W*H))*100).toFixed(1),
          clipped: gTop < 0 || gBot > H || gL < 0 || gR > W,
          realGeom: { top: Math.round(gTop), bottom: Math.round(H-gBot), left: Math.round(gL), right: Math.round(W-gR) },
        };
      };
      const mk = () => { const c = cam.clone(); c.aspect = cam.aspect; c.updateProjectionMatrix(); return c; };

      // A: shipped — 3.2 headroom at the OUTER frame corners (+-10.3)
      const A = []; for (const x of [-R,R]) for (const z of [-R,R]) for (const y of [0, PH]) A.push(new THREE.Vector3(x,y,z));
      // B: true silhouette — plate corners flat, headroom only where pieces stand (+-7.95)
      const B = [];
      for (const x of [-R,R]) for (const z of [-R,R]) B.push(new THREE.Vector3(x,0,z));
      for (const x of [-P,P]) for (const z of [-P,P]) B.push(new THREE.Vector3(x,PH,z));
      // C: no headroom at all
      const C = []; for (const x of [-R,R]) for (const z of [-R,R]) C.push(new THREE.Vector3(x,0,z));

      const pa = mk(), pb = mk(), pc = mk();
      const da = fit(pa, A), db = fit(pb, B), dc = fit(pc, C);
      return {
        canvas: { w: +W.toFixed(1), h: +H.toFixed(1) },
        A_shipped: { dist: +da.toFixed(2), ...report(pa) },
        B_trueSilhouette: { dist: +db.toFixed(2), ...report(pb) },
        C_noHeadroom: { dist: +dc.toFixed(2), ...report(pc) },
      };
    });
    log('\n### silhouette ' + size.name);
    log(JSON.stringify(r, null, 2));
    log('B vs A board px: ' + (((r.B_trueSilhouette.areaPx / r.A_shipped.areaPx) - 1) * 100).toFixed(1) + '%');
  }
  expect(true).toBe(true);
});
