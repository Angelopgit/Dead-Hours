import type { LobbyPlayer } from '@dead-hours/shared';
import { h } from './dom';
import { talkHint } from '../core/Input';
import { settings } from '../core/Settings';
import { audio } from '../audio/AudioEngine';
import { comms } from '../network/Comms';
import type { NetLink } from '../network/NetLink';

/** What this player's own microphone is doing, in a few words. */
export function micLine(link: NetLink): string {
  const v = settings.value.voice;
  if (!v.enabled) return 'VOICE OFF (SETTINGS → VOICE)';
  const mic = link.voice.micState;
  if (mic === 'denied') return 'MICROPHONE BLOCKED: ALLOW IT IN THE BROWSER';
  if (mic === 'unsupported') return 'NO MICROPHONE ACCESS IN THIS BROWSER';
  if (mic === 'asking') return 'WAITING FOR MICROPHONE PERMISSION…';
  const sending = link.voice.sending;
  if (sending) return sending === 'radio' ? 'ON THE RADIO' : 'TALKING';
  return talkHint(v.mode === 'vad', link.voice.inNight);
}

/**
 * Voice and chat controls for one player in the room: a speaking light, the connection, voice mute
 * and volume, hiding their chat, and blocking them (no chat or voice either way, kept between visits).
 * `refresh()` updates the light and connection line; call it a few times a second while shown.
 */
export function playerComms(link: NetLink, p: LobbyPlayer, redraw: () => void): { el: HTMLElement; refresh: () => void } {
  const dot = h('i', { class: 'vox-dot', title: 'Speaking' });
  const state = h('small', { class: 'vox-state' });
  const me = p.id === link.id;
  const btn = (label: string, on: boolean, fn: () => void, title: string) =>
    h('button', { class: `chip ${on ? 'on' : ''}`, title, 'aria-pressed': String(on), onclick: () => { audio.ui('click'); fn(); redraw(); } }, label);
  const parts: HTMLElement[] = [dot, state];
  if (!me) {
    const muted = comms.voiceMuted(p.pid);
    const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: comms.volume(p.pid), class: 'vox-vol', 'aria-label': `${p.name} voice volume`, title: 'Voice volume' }) as HTMLInputElement;
    vol.addEventListener('input', () => comms.setVolume(p.pid, Number(vol.value)));
    const blocked = comms.blocked(p.pid);
    parts.push(
      btn(muted ? 'MUTED' : 'MUTE', muted, () => comms.setVoiceMuted(p.pid, !muted), 'Mute their voice'),
      vol,
      btn(comms.textMuted(p.pid) ? 'CHAT HIDDEN' : 'HIDE CHAT', comms.textMuted(p.pid), () => comms.setTextMuted(p.pid, !comms.textMuted(p.pid)), 'Hide their chat messages'),
      btn(blocked ? 'BLOCKED' : 'BLOCK', blocked, () => comms.setBlocked(p.pid, p.name, !blocked), 'No chat or voice between you, in every game'),
    );
  }
  const el = h('div', { class: 'player-comms' }, ...parts);
  const refresh = () => {
    const talk = link.voice.talkOf(p.id);
    dot.classList.toggle('on', link.voice.speaking(p.id));
    dot.classList.toggle('radio', talk === 'radio');
    if (me) {
      state.textContent = micLine(link);
      return;
    }
    if (comms.blocked(p.pid)) {
      state.textContent = '';
      return;
    }
    const s = link.voice.stateOf(p.id);
    state.textContent = !settings.value.voice.enabled ? ''
      : !s ? 'NO VOICE'
        : s.state === 'connected' ? (s.rtt !== null ? `VOICE ${Math.round(s.rtt * 1000)} MS` : 'VOICE')
          : s.state === 'failed' ? 'VOICE CAN\'T CONNECT' : 'VOICE CONNECTING';
  };
  refresh();
  return { el, refresh };
}
