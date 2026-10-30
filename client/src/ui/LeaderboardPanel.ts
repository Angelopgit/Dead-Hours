import { h } from './dom';
import { clock } from './HUD';
import { audio } from '../audio/AudioEngine';
import { net } from '../network/Net';
import { account } from '../network/Account';

interface BoardEntry {
  name: string;
  value: number;
  mode: 'solo' | 'online';
  at: number;
}

type Tab = 'survival' | 'kills' | 'you';

/**
 * The two boards (longest survival, most kills; each player's best) and the player's own saved
 * survivor: lifetime stats, places, and the player key that carries them to another device.
 */
export class LeaderboardPanel {
  readonly el: HTMLElement;
  private readonly tabs = h('div', { class: 'tabs' });
  private readonly body = h('div', { class: 'board' });
  private tab: Tab = 'survival';
  private boards: { survival: BoardEntry[]; kills: BoardEntry[] } | null = null;
  private failed = false;
  private readonly off: () => void;

  constructor(onClose: () => void) {
    this.el = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Leaderboards' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); onClose(); } }, 'CLOSE ✕'),
      h('h2', {}, 'LEADERBOARDS'),
      this.tabs,
      this.body,
    );
    this.off = account.onChange(() => { if (this.tab === 'you') this.render(); });
    this.render();
    void this.load();
    void account.sync();
  }

  private async load(): Promise<void> {
    try {
      this.boards = await net.api<{ survival: BoardEntry[]; kills: BoardEntry[] }>('/api/leaderboard?limit=25');
      this.failed = false;
    } catch {
      this.failed = true;
    }
    this.render();
  }

  private render(): void {
    const tab = (id: Tab, label: string) => h('button', {
      class: `tab ${this.tab === id ? 'active' : ''}`,
      onclick: () => { audio.ui('click'); this.tab = id; this.render(); },
    }, label);
    this.tabs.replaceChildren(tab('survival', 'Longest survival'), tab('kills', 'Most kills'), tab('you', 'Your survivor'));
    if (this.tab === 'you') this.renderYou();
    else this.renderBoard(this.tab);
  }

  private renderBoard(kind: 'survival' | 'kills'): void {
    if (this.failed) {
      this.body.replaceChildren(h('p', {}, 'The game server can\'t be reached right now.'));
      return;
    }
    if (!this.boards) {
      this.body.replaceChildren(h('p', {}, 'Loading…'));
      return;
    }
    const rows = this.boards[kind];
    this.body.replaceChildren(
      rows.length
        ? h('ol', { class: 'board-list' }, ...rows.map((r, i) => h('li', {},
          h('span', { class: 'place' }, String(i + 1)),
          h('span', { class: 'who' }, r.name.toUpperCase()),
          h('span', { class: `mode ${r.mode}` }, r.mode.toUpperCase()),
          h('b', {}, kind === 'survival' ? clock(r.value) : String(r.value)))))
        : h('p', {}, 'Nobody is on the board yet. Survive a night to be the first.'),
      h('p', { class: 'board-note' }, 'Each player\'s best run. Online runs are recorded by the game server; solo runs are reported by the player\'s own browser, checked for what a real run could reach, and marked SOLO.'),
    );
  }

  private renderYou(): void {
    const p = account.profile;
    const stat = (label: string, v: string) => h('div', {}, label, h('b', {}, v));
    const keyInput = h('input', { class: 'code-input wide', type: 'text', spellcheck: 'false', placeholder: 'PASTE A PLAYER KEY', 'aria-label': 'Player key' }) as HTMLInputElement;
    const note = h('p', { class: 'board-note' });
    const use = h('button', {
      class: 'btn',
      onclick: async () => {
        audio.ui('click');
        note.textContent = 'LOADING…';
        note.textContent = (await account.useKey(keyInput.value)) ? (account.profile ? 'SURVIVOR LOADED' : 'NO SURVIVOR SAVED UNDER THAT KEY YET') : 'THAT IS NOT A PLAYER KEY';
      },
    }, 'USE KEY');
    const copy = h('button', {
      class: 'btn',
      onclick: () => {
        audio.ui('click');
        void navigator.clipboard?.writeText(account.key).then(() => (note.textContent = 'KEY COPIED'), () => (note.textContent = 'SELECT THE KEY TO COPY IT'));
      },
    }, 'COPY');
    this.body.replaceChildren(
      p
        ? h('div', {},
          h('h3', {}, p.name.toUpperCase()),
          h('div', { class: 'results-stats board-stats' },
            stat('NIGHTS', String(p.stats.runs)),
            stat('BEST SURVIVAL', clock(p.stats.bestSurvived)),
            stat('BEST KILLS', String(p.stats.bestKills)),
            stat('KILLS', String(p.stats.kills)),
            stat('HEADSHOTS', String(p.stats.headshots)),
            stat('ARMS TORN OFF', String(p.stats.limbsSevered)),
            stat('TIME SURVIVED', clock(p.stats.timeSurvived)),
            stat('SURVIVAL PLACE', p.rankSurvival ? `#${p.rankSurvival}` : '—'),
            stat('KILLS PLACE', p.rankKills ? `#${p.rankKills}` : '—'),
          ))
        : h('p', {}, net.status === 'online' ? 'Your survivor is saved here once you change it or finish a night.' : 'The game server can\'t be reached right now.'),
      h('h3', {}, 'Player key'),
      h('p', {}, 'Your survivor, stats and places are saved under this key. Keep it to yourself; enter it on another device to play as the same survivor there.'),
      h('div', { class: 'code-row' }, h('code', { class: 'player-key' }, account.displayKey), copy),
      h('div', { class: 'code-row' }, keyInput, use),
      note,
    );
  }

  dispose(): void {
    this.off();
  }
}
