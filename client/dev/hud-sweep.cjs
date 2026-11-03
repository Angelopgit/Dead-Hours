// Dev-only: runs the HUD layout audit (dev/hud.html, window.__hudAudit) across phone and tablet sizes,
// UI scales and touch button sizes, and lists every overlap, off-screen piece or piece in a notch.
// Needs Playwright with Chromium and the Vite dev server on 5173 (`npx vite --port 5173` in client/):
//
//   node client/dev/hud-sweep.cjs                       every size, scene, UI scale 0.8..1.4, buttons 1
//   node client/dev/hud-sweep.cjs --tc 0.75,1,1.4 --ui 1,1.4 --sizes 568x320,844x390 --scenes foot,car
//
// Exits 1 when anything is found. Phones with a notch get their safe-area insets emulated.
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const list = (k, d) => opt(k, d).split(',');
// width x height, notch inset left/right, home bar inset bottom (landscape).
const SIZES = [
  ['568x320', 0, 0], ['640x360', 0, 0], ['667x375', 0, 0], ['736x414', 0, 0], ['740x360', 0, 0], ['800x360', 0, 0],
  ['812x375', 44, 21], ['844x390', 47, 21], ['852x393', 59, 21], ['896x414', 48, 21], ['915x412', 0, 0], ['932x430', 59, 21],
  ['1024x768', 0, 20], ['1180x820', 0, 20],
];
const sizes = opt('--sizes') ? SIZES.filter(([s]) => list('--sizes').includes(s)) : SIZES;
const scenes = list('--scenes', 'foot,skate,car,ride,downed,dead,lost');
const uis = list('--ui', '0.8,0.9,1,1.1,1.2,1.3,1.4');
const tcs = list('--tc', '1');
const host = opt('--host', 'http://localhost:5173');

(async () => {
  const browser = await chromium.launch();
  let found = 0;
  for (const [size, side, bottom] of sizes) {
    const [width, height] = size.split('x').map(Number);
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { found++; console.log(`${size} page error: ${e.message}`); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: side, right: side, bottom } });
    for (const tc of tcs) for (const scene of scenes) for (const ui of uis) {
      await page.goto(`${host}/dev/hud.html?scene=${scene}&ui=${ui}&tc=${tc}`);
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      await page.evaluate(() => document.fonts.ready);
      for (const f of await page.evaluate(() => window.__hudAudit())) {
        found++;
        console.log(`${size} ${scene} ui ${ui} buttons ${tc}: ${f.a}${f.b ? ` x ${f.b}` : ` ${f.kind}`}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  console.log(found ? `${found} problems` : 'clean');
  process.exit(found ? 1 : 0);
})();
