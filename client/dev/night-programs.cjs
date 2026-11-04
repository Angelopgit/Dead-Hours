// Dev-only: plays solo nights back to back through the main menu and prints, after each night and each return to
// the menu, the shader programs, GPU geometries and textures, scene objects and JS heap. Every count should be the
// same from the second night on: a number that grows each night is something a night leaves behind (programs grew
// by 8 a night until keepShaderSources in core/Preload.ts). Needs Playwright with Chromium and the Vite dev server
// on 5173 (`npx vite --port 5173` in client/):
//
//   node client/dev/night-programs.cjs [nights=3] [--host http://localhost:5173]
//
// Exits 1 when the program count grows after the first night.
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const nights = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('deadhours.settings.v1', JSON.stringify({
    graphics: { resolutionScale: 0.3, adaptiveResolution: false, filmGrain: false, motionBlur: false },
    audio: { master: 0, music: 0, ambient: 0 }, profile: { name: 'Tester', primary: 'ar' },
  })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
  await page.goto(`${host}/?holiday=off`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__deadHours?.menu, null, { timeout: 300000, polling: 500 });
  const counts = (label) => page.evaluate(async (label) => {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 300));
    const g = window.__deadHours, r = g.engine.renderer;
    let objects = 0;
    g.engine.scene.traverse(() => objects++);
    return { label, programs: r.info.programs.length, geometries: r.info.memory.geometries, textures: r.info.memory.textures, objects,
      heap: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : NaN };
  }, label);
  const rows = [await counts('menu')];
  for (let i = 1; i <= nights; i++) {
    await page.evaluate(() => { window.__deadHours.startSolo(); });
    await page.waitForFunction(() => window.__deadHours.session && window.__deadHours.session.debug.phase() !== 'loading', null, { timeout: 1200000, polling: 1000 });
    await page.waitForFunction(() => window.__deadHours.session.debug.phase() !== 'intro' || (window.__deadHours.session.finishIntro(), false), null, { timeout: 1200000, polling: 1000 });
    await page.waitForTimeout(6000);
    rows.push(await counts(`night ${i}`));
    await page.evaluate(() => window.__deadHours.quitToMenu());
    await page.waitForFunction(() => !window.__deadHours.session, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(2000);
    rows.push(await counts(`menu ${i}`));
  }
  for (const r of rows) console.log(`${r.label.padEnd(8)} programs ${r.programs}  geometries ${r.geometries}  textures ${r.textures}  objects ${r.objects}  heap ${r.heap} MB`);
  await browser.close();
  const grew = rows[rows.length - 1].programs - rows[2].programs;
  console.log(grew > 0 ? `programs grew by ${grew} after the first night` : 'no programs added after the first night');
  process.exit(grew > 0 ? 1 : 0);
})();
