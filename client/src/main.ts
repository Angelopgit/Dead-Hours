import './ui/styles.css';
import gsap from 'gsap';
import { Game } from './core/Game';

// Interface animations follow real time even when a frame hitches (shader compiles, slow GPUs),
// so fades and the weapon table glide never stall half-way.
gsap.ticker.lagSmoothing(0);

const boot = document.createElement('div');
boot.className = 'boot';
boot.textContent = 'LOADING';
document.body.append(boot);

new Game().boot().catch((err) => {
  console.error(err);
  boot.textContent = `FAILED TO START: ${err instanceof Error ? err.message : String(err)}`;
});
