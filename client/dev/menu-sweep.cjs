// Dev-only: opens PLAY on the real main menu and resizes the window through every desktop height, holiday
// logo on and off, named and unnamed (the unnamed name row has a hint line on tall windows), and lists each
// window where the menu column runs past its band, so the last items (SETTINGS, CREDITS) need scrolling.
// Run it after changing anything in the menu column. Needs Playwright with Chromium and the Vite dev server
// on 5173 (`npx vite --port 5173` in client/):
//
//   node client/dev/menu-sweep.cjs                       widths 1280,1536,1920, heights 501..1000, UI 0.8,1
//   node client/dev/menu-sweep.cjs --widths 1366 --heights 650,714 --ui 1
//
// Exits 1 when anything is found. UI scales over 100% are left out: they scroll on short windows by design.
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const list = (k, d) => opt(k, d).split(',').map(Number);
const widths = list('--widths', '1280,1536,1920');
const heights = opt('--heights') ? list('--heights')
  : [...Array.from({ length: 26 }, (_, i) => 501 + i * 20), 700, 701, 860, 861];
const uis = list('--ui', '0.8,1');
const host = opt('--host', 'http://localhost:5173');
// The menu renders the night street behind it: keep the GPU work small so the sweep stays quick.
const GRAPHICS = { resolutionScale: 0.3, adaptiveResolution: false, shadows: 'off', bloom: false, filmGrain: false, antialias: false,
  fogQuality: 'low', particleQuality: 'low', textureQuality: 'low' };

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let found = 0, cases = 0;
  for (const holiday of ['on', 'off']) for (const name of ['Angelo', null]) for (const ui of uis) {
    const ctx = await browser.newContext({ viewport: { width: widths[0], height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(([graphics, name, ui]) => localStorage.setItem('deadhours.settings.v1', JSON.stringify({
      graphics, audio: { master: 0, music: 0, ambient: 0 }, accessibility: { uiScale: ui },
      profile: name ? { name, primary: 'ar' } : { primary: 'ar' },
    })), [GRAPHICS, name, ui]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { found++; console.log(`page error: ${e.message}`); });
    await page.goto(`${host}/?holiday=${holiday}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__deadHours?.menu && document.querySelector('.menu-name-input'), null, { timeout: 300000, polling: 500 });
    await page.evaluate(async () => {
      window.__deadHours.engine.paused = true;
      await document.fonts.ready;
      [...document.querySelectorAll('.menu-main .menu-item')].find((b) => b.textContent.trim().startsWith('PLAY')).click();
    });
    await page.waitForTimeout(1200);
    for (const width of widths) for (const height of heights) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const measure = () => page.evaluate(() => { const m = document.querySelector('.menu > .menu-main'); return m.scrollHeight - m.clientHeight; });
      // A busy software-rendered frame can leave one measure from mid-relayout (a few px once in 720): look again.
      let hidden = await measure();
      if (hidden > 0) { await page.waitForTimeout(500); hidden = await measure(); }
      cases++;
      if (hidden > 0) { found++; console.log(`${width}x${height} holiday ${holiday} ${name ? 'named' : 'unnamed'} UI ${ui * 100}%: PLAY open hides ${hidden}px`); }
    }
    await ctx.close();
  }
  await browser.close();
  console.log(found ? `${found} problem(s) in ${cases} windows` : `menu fits with PLAY open in all ${cases} windows`);
  process.exit(found ? 1 : 0);
})();
