import { GAME, ROOMS, SERVERS_FULL, WEAPONS, encodeAppearance, encodeLoadout, sanitizeAppearance, type BeginMsg, type LobbyMsg, type RoomListing, type WeaponId } from '@dead-hours/shared';
import { h } from './dom';
import { clock } from './HUD';
import { settings } from '../core/Settings';
import { audio } from '../audio/AudioEngine';
import { net } from '../network/Net';
import { NetLink } from '../network/NetLink';
import { account } from '../network/Account';
import { ChatBox } from './ChatBox';
import { playerComms } from './PlayerComms';

export interface OnlineCallbacks {
  /** The host started the night. */
  onBegin: (link: NetLink, begin: BeginMsg) => void;
  onClose: () => void;
  /** Play alone instead (offered when the servers are full). */
  onSolo: () => void;
}

type View = 'browse' | 'host' | 'lobby' | 'full';

function joinOptions() {
  const p = settings.value.profile;
  return { name: p.name, primary: p.primary, appearance: encodeAppearance(sanitizeAppearance(p.appearance)), token: account.key, session: account.session ?? undefined, builds: encodeLoadout(account.loadout) };
}

/** What a failed join or create means for the player. */
function reason(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  if (m.includes('locked') || m.includes('full')) return 'THAT GAME IS FULL OR ALREADY UNDER WAY';
  if (m.includes('not found') || m.includes('no rooms') || m.includes('invalid')) return 'THAT GAME IS GONE';
  return 'COULD NOT REACH THE GAME SERVER';
}

/**
 * Online play from the main menu: the open games list and join-by-code, hosting a game
 * (public, or private for code only), and the room's lobby where the host starts the night.
 */
export class OnlineMenu {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'online' });
  private readonly status = h('p', { class: 'online-status' });
  private readonly close: HTMLButtonElement;
  private view: View;
  private link: NetLink | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private disposed = false;
  /** The room's chat panel (kept across lobby redraws) and the speaking lights' refresh. */
  private chatBox: ChatBox | null = null;
  private comms: (() => void)[] = [];
  private commsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(start: 'browse' | 'host', private readonly cb: OnlineCallbacks, link?: NetLink) {
    this.close = h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); this.back(); } }, 'CLOSE ✕');
    this.el = h('div', { class: 'panel online-panel', role: 'dialog', 'aria-label': 'Online' }, this.close, this.body, this.status);
    this.view = start;
    if (link) this.attach(link);
    else this.render();
  }

  /** ESC / CLOSE: out of the lobby means out of the room. */
  back(): void {
    if (this.link) {
      this.dropComms();
      this.link.leave();
      this.link = null;
      this.view = 'browse';
      this.render();
      return;
    }
    this.cb.onClose();
  }

  /** The room link is handed to the game when the night begins (not closed with the menu). */
  release(): NetLink | null {
    const l = this.link;
    this.link = null;
    return l;
  }

  private say(text: string, tone: '' | 'bad' = ''): void {
    this.status.textContent = text;
    this.status.className = `online-status ${tone}`;
  }

  private button(label: string, fn: () => void, cls = 'btn'): HTMLButtonElement {
    return h('button', {
      class: cls,
      onmouseenter: () => audio.ui('hover'),
      onclick: () => { audio.ui('click'); fn(); },
    }, label);
  }

  private render(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.close.textContent = this.view === 'lobby' ? 'LEAVE ✕' : 'CLOSE ✕';
    if (this.view === 'browse') this.renderBrowse();
    else if (this.view === 'host') this.renderHost();
    else if (this.view === 'full') this.renderFull();
    else this.renderLobby();
  }

  // ------------------------------------------------------------------ open games and codes

  private renderBrowse(): void {
    const code = h('input', {
      class: 'code-input', type: 'text', maxlength: 6, spellcheck: 'false', placeholder: 'CODE', 'aria-label': 'Join code',
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') void this.joinCode(code.value); },
    }) as HTMLInputElement;
    const list = h('div', { class: 'room-list' }, h('p', {}, 'Looking for games…'));
    this.body.replaceChildren(
      h('h2', {}, 'JOIN A GAME'),
      h('h3', {}, 'With a code'),
      h('div', { class: 'code-row' }, code, this.button('JOIN', () => void this.joinCode(code.value), 'btn primary')),
      h('h3', {}, 'Open games'),
      list,
      h('div', { class: 'actions' }, this.button('HOST A GAME INSTEAD', () => { this.view = 'host'; this.say(''); this.render(); })),
    );
    const refresh = async () => {
      try {
        const rooms = await net.api<RoomListing[]>('/api/rooms');
        if (this.disposed || this.view !== 'browse') return;
        list.replaceChildren(...(rooms.length ? rooms.map((r) => this.roomRow(r)) : [h('p', {}, 'No open games right now. Host one and send your friends the code.')]));
      } catch {
        if (!this.disposed) list.replaceChildren(h('p', {}, 'The game server can\'t be reached right now.'));
      }
    };
    void refresh();
    this.poll = setInterval(() => void refresh(), 3000);
  }

  private roomRow(r: RoomListing): HTMLElement {
    const open = r.status === 'lobby' && r.players < r.maxPlayers;
    const state = r.status === 'playing' ? `PLAYING${r.survived ? ` · ${clock(r.survived)}` : ''}` : r.players >= r.maxPlayers ? 'FULL' : 'IN THE LOBBY';
    return h('div', { class: 'room-row' },
      h('div', {}, h('b', {}, r.name.toUpperCase()), h('small', {}, `HOST ${r.host.toUpperCase()} · ${r.players}/${r.maxPlayers} · ${state}`)),
      // Only rooms that can be joined get a button.
      open ? this.button('JOIN', () => void this.join(() => net.client().joinById(r.roomId, joinOptions()))) : h('span', { class: 'room-state' }, state),
    );
  }

  private async joinCode(raw: string): Promise<void> {
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) {
      this.say('A JOIN CODE IS 5 LETTERS AND NUMBERS', 'bad');
      return;
    }
    await this.join(async () => {
      const { roomId } = await net.api<{ roomId: string }>(`/api/code/${code}`).catch(() => {
        throw new Error('not found');
      });
      return net.client().joinById(roomId, joinOptions());
    });
  }

  // ------------------------------------------------------------------ hosting

  private renderHost(): void {
    const name = settings.value.profile.name;
    const title = h('input', { class: 'code-input wide', type: 'text', maxlength: 32, spellcheck: 'false', value: `${name}'s safehouse`, 'aria-label': 'Game name' }) as HTMLInputElement;
    let hidden = false;
    const seg = h('div', { class: 'seg' });
    const draw = () => seg.replaceChildren(
      h('button', { class: hidden ? '' : 'on', onclick: () => { hidden = false; draw(); } }, 'Public'),
      h('button', { class: hidden ? 'on' : '', onclick: () => { hidden = true; draw(); } }, 'Private'),
    );
    draw();
    this.body.replaceChildren(
      h('h2', {}, 'HOST A GAME'),
      h('div', { class: 'row' }, h('label', {}, 'Name'), title),
      h('div', { class: 'row' }, h('label', {}, 'Who can join', h('span', { class: 'hint' }, 'Private games are joined with the code only')), seg),
      h('p', {}, `Up to ${GAME.maxPlayers} survivors. You start the night when everyone is in; the zombies are run by the server, so everyone sees the same night.`),
      h('div', { class: 'actions' },
        this.button('BACK', () => { this.view = 'browse'; this.say(''); this.render(); }),
        this.button('CREATE GAME', () => void this.join(() => net.client().create(ROOMS.survival, { ...joinOptions(), lobbyName: title.value, private: hidden })), 'btn primary'),
      ),
    );
  }

  /** Hosting refused because every game server is at its limit. */
  private renderFull(): void {
    this.body.replaceChildren(
      h('h2', {}, 'SERVERS ARE FULL'),
      h('p', {}, 'Every game server is running as many nights as it can, so a new game can\'t start right now. Games already running can still be joined with their code, and one opens up as soon as a night ends.'),
      h('div', { class: 'actions' },
        this.button('TRY AGAIN', () => { this.view = 'host'; this.render(); }),
        this.button('JOIN A GAME', () => { this.view = 'browse'; this.render(); }),
        this.button('PLAY SOLO', () => this.cb.onSolo(), 'btn primary'),
      ),
    );
  }

  private async join(open: () => Promise<import('colyseus.js').Room>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('CONNECTING…');
    try {
      const room = await open();
      if (this.disposed) {
        void room.leave(true);
        return;
      }
      this.say('');
      this.attach(new NetLink(room));
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === SERVERS_FULL) {
        this.view = 'full';
        this.say('');
        this.render();
      } else this.say(reason(e), 'bad');
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ the room's lobby

  private attach(link: NetLink): void {
    this.link = link;
    this.view = 'lobby';
    this.dropComms();
    this.chatBox = new ChatBox(link, 'lobby');
    this.commsTimer = setInterval(() => {
      for (const f of this.comms) f();
    }, 150);
    link.handlers = {
      lobby: () => this.view === 'lobby' && this.renderLobby(),
      begin: (b) => {
        this.dropComms();
        this.link = null;
        this.cb.onBegin(link, b);
      },
      notice: (t) => this.say(t, 'bad'),
      closed: () => {
        if (this.link !== link) return;
        this.dropComms();
        this.link = null;
        this.view = 'browse';
        this.render();
        this.say('DISCONNECTED FROM THE GAME', 'bad');
      },
    };
    this.render();
  }

  private renderLobby(): void {
    const link = this.link;
    if (!link) return;
    const m: LobbyMsg | null = link.lobby;
    if (!m) {
      this.body.replaceChildren(h('h2', {}, 'JOINING…'));
      return;
    }
    const me = m.players.find((p) => p.id === link.id);
    const codeEl = h('b', { class: 'room-code' }, m.code);
    const copy = this.button('COPY', () => {
      void navigator.clipboard?.writeText(m.code).then(() => this.say('CODE COPIED'), () => this.say('SELECT THE CODE TO COPY IT'));
    });
    this.comms = [];
    const players = m.players.map((p) => {
      const c = playerComms(link, p, () => this.renderLobby());
      this.comms.push(c.refresh);
      return h('div', { class: 'lobby-entry' },
        h('div', { class: 'lobby-player' },
          h('span', {}, p.name.toUpperCase()),
          h('small', {}, WEAPONS[p.primary as WeaponId]?.model ?? ''),
          p.id === m.host ? h('em', {}, 'HOST') : p.ready ? h('em', { class: 'ok' }, 'READY') : h('em', { class: 'dim' }, 'NOT READY'),
          p.id === link.id ? h('em', { class: 'dim' }, 'YOU') : null,
        ),
        c.el,
      );
    });
    const waiting = m.players.filter((p) => p.id !== m.host && !p.ready).length;
    const draw = () => this.body.replaceChildren(
      h('h2', {}, m.name.toUpperCase()),
      h('div', { class: 'code-box' }, h('span', {}, m.private ? 'PRIVATE · JOIN CODE' : 'JOIN CODE'), codeEl, copy),
      h('h3', {}, `Survivors ${m.players.length}/${GAME.maxPlayers}`),
      h('div', { class: 'lobby-list' }, ...players),
      h('div', { class: 'actions' },
        link.isHost
          ? this.button(waiting ? `START ANYWAY (${waiting} NOT READY)` : 'START THE NIGHT', () => link.start(), 'btn primary')
          : this.button(me?.ready ? 'NOT READY' : 'READY', () => link.setReady(!me?.ready), 'btn primary'),
      ),
      h('p', { class: 'lobby-hint' }, link.isHost ? 'Send your friends the code. Everyone plays the survivor and rifle they joined with.' : 'Waiting for the host to start the night.'),
      h('h3', {}, 'Chat'),
      ...(this.chatBox ? [this.chatBox.el] : []),
    );
    if (this.chatBox) this.chatBox.preserve(draw);
    else draw();
  }

  private dropComms(): void {
    this.chatBox?.dispose();
    this.chatBox = null;
    this.comms = [];
    if (this.commsTimer) clearInterval(this.commsTimer);
    this.commsTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.dropComms();
    if (this.poll) clearInterval(this.poll);
    this.link?.leave();
    this.link = null;
    this.el.remove();
  }
}
