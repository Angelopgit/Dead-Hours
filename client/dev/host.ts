/**
 * Dev-only: runs a night in the host worker with nobody watching and lists the worker's clock
 * second by second, with whether the tab was visible (`/dev/host.html`; `?prep=0` keeps the
 * preparation phase). For finding out what a browser does to a player host's night while its
 * tab is hidden, which headless browsers can't show. Not part of the game build.
 */
import { DEFAULT_APPEARANCE, NO_UNLOCKS, S2C, encodeAppearance, type HostMember, type Snapshot } from '@dead-hours/shared';
import { DeviceHost } from '../src/network/host/DeviceHost';

const q = new URLSearchParams(location.search);
const now = document.getElementById('now')!;
const rows = document.getElementById('rows')!;
let snapshots = 0;
let zombies = 0;
let second = 0;
let wasHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) wasHidden = true;
});

const members: HostMember[] = ['One', 'Two', 'Three', 'Four'].map((name, i) => ({
  id: `p${i}`, name, primary: 'ar', secondary: 'pistol', appearance: encodeAppearance(DEFAULT_APPEARANCE), builds: {}, unlocks: NO_UNLOCKS,
}));

const host = new DeviceHost((up) => {
  if (up.k !== 'out') return;
  if (up.t === S2C.begin) for (const id of up.to) host.down({ k: 'in', from: id, t: 'loaded' });
  else if (up.t === S2C.snap) {
    snapshots++;
    zombies = (up.m as Snapshot).z.length;
  }
});
host.down({ k: 'start', seed: 20261117, members, debug: true });
if (q.get('prep') !== '0') host.down({ k: 'in', from: 'p0', t: 'debug', m: { cmd: 'skipPreparation' } });
for (const m of members) host.down({ k: 'in', from: m.id, t: 'debug', m: { cmd: 'god', on: true } });

host.onTicks = (rate, gap, playing) => {
  now.textContent = host.clock;
  if (!playing) return;
  const hidden = document.hidden || wasHidden;
  wasHidden = document.hidden;
  const cell = (text: string | number) => Object.assign(document.createElement('td'), { textContent: String(text) });
  const tr = document.createElement('tr');
  tr.className = rate < 50 ? 'slow' : hidden ? 'hidden' : '';
  tr.append(cell(++second), cell(hidden ? 'hidden' : 'visible'), cell(rate), cell(gap), cell(snapshots), cell(zombies));
  snapshots = 0;
  rows.prepend(tr);
  while (rows.childElementCount > 600) rows.lastElementChild?.remove();
};
// Read by headless checks.
(window as unknown as { hostClock: () => unknown }).hostClock = () => ({ ready: host.ready, failed: host.failed, rate: host.rate, gap: host.gap, hidden: host.hidden, second, zombies });
