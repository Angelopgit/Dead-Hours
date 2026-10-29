import './ui/styles.css';
import { Game } from './core/Game';

const boot = document.createElement('div');
boot.className = 'boot';
boot.textContent = 'LOADING';
document.body.append(boot);

new Game().boot().catch((err) => {
  console.error(err);
  boot.textContent = `FAILED TO START: ${err instanceof Error ? err.message : String(err)}`;
});
