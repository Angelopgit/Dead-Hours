import { C2S, type IceConfig, type LobbyPlayer, type RtcIn, type RtcSignal, type TalkMode, type TalkMsg, type Vec3 } from '@dead-hours/shared';
import { settings, type SettingsData } from '../core/Settings';
import { typing } from '../core/Input';
import { audio } from '../audio/AudioEngine';
import { comms } from './Comms';

export type MicState = 'off' | 'asking' | 'on' | 'denied' | 'unsupported';
export type PeerState = 'connecting' | 'connected' | 'failed';

/** A voice counts as speaking while its level is above this (dBFS)... */
const SPEAKING_DB = -50;
/** ...and for this long after (s), so the indicator doesn't flicker between words. */
const SPEAKING_HOLD = 0.3;
/** Voice activation keeps sending this long after the level drops (s): word endings aren't cut. */
const VAD_HANG = 0.45;
/** Voices fade out between these distances (m). */
const FADE_FROM = 35;
const FADE_TO = 50;
/** What we ask of whoever sends to us: Opus with forward error correction, silence suppression, mono up to 40 kb/s. */
const OPUS: Record<string, string> = { useinbandfec: '1', usedtx: '1', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: '40000' };
/** Keep trying a failed connection this many times (ICE restart) before showing it as failed. */
const RESTARTS = 3;

/** Sets the Opus parameters in a session description (merged into the codec's fmtp line). */
export function tuneOpus(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const found = line.exec(sdp);
  const params = new Map<string, string>();
  for (const kv of found?.[1].split(';') ?? []) {
    const [k, v = ''] = kv.trim().split('=');
    if (k) params.set(k, v);
  }
  for (const [k, v] of Object.entries(OPUS)) params.set(k, v);
  const fmtp = `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  if (found) return sdp.replace(line, fmtp);
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*)`, 'i'), `$1\r\n${fmtp}`);
}

/** Opus first in what this end will accept (it is every browser's default; this makes sure). */
function preferOpus(t: RTCRtpTransceiver): void {
  const caps = typeof RTCRtpReceiver.getCapabilities === 'function' ? RTCRtpReceiver.getCapabilities('audio') : null;
  if (!caps || typeof t.setCodecPreferences !== 'function') return;
  const opus = caps.codecs.filter((c) => /opus/i.test(c.mimeType));
  try {
    t.setCodecPreferences([...opus, ...caps.codecs.filter((c) => !/opus/i.test(c.mimeType))]);
  } catch {
    // Older engines: the default order already starts with Opus.
  }
}

/** The microphone as the browser should process it: echo cancellation, noise suppression, auto gain, mono. */
export function micConstraints(v: SettingsData['voice'], device = v.device): MediaTrackConstraints {
  return {
    echoCancellation: v.echoCancellation,
    noiseSuppression: v.noiseSuppression,
    autoGainControl: v.autoGainControl,
    channelCount: 1,
    ...(device ? { deviceId: { exact: device } } : {}),
  };
}

/** Opens the microphone; a saved device that is gone falls back to the default one. */
export async function openMic(v: SettingsData['voice']): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(v), video: false });
  } catch (e) {
    if (v.device && (e as DOMException)?.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ audio: micConstraints(v, ''), video: false });
    }
    throw e;
  }
}

/** Level of what an analyser hears, in dBFS (RMS). */
export function levelOf(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return 10 * Math.log10(sum / buf.length + 1e-12);
}

/** Microphone level meter for Settings (no room needed). */
export class MicTest {
  state: MicState = 'off';
  level = -100;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly buf = new Float32Array(1024);
  private stopped = false;

  async start(): Promise<void> {
    const ctx = audio.ctx;
    if (!navigator.mediaDevices?.getUserMedia || !(ctx instanceof AudioContext)) {
      this.state = 'unsupported';
      return;
    }
    this.state = 'asking';
    try {
      const stream = await openMic(settings.value.voice);
      if (this.stopped) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      this.source = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      this.state = 'on';
    } catch {
      this.state = 'denied';
    }
  }

  /** Current level (dBFS); call each frame while shown. */
  read(): number {
    if (this.analyser) this.level = levelOf(this.analyser, this.buf);
    return this.level;
  }

  stop(): void {
    this.stopped = true;
    this.source?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.state = 'off';
  }
}

interface Graph {
  /** Chrome only feeds Web Audio from a remote WebRTC stream that also plays in a media element (muted here). */
  el: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  /** This player's volume (0 when muted). */
  user: GainNode;
  /** In the lobby and on the results: straight, no position. */
  flat: GainNode;
  /** In play: from where they stand, through the walls in between. */
  near: GainNode;
  wall: BiquadFilterNode;
  wallGain: GainNode;
  panner: PannerNode;
  /** Team radio: band-limited and a little driven. */
  radio: GainNode;
}

/** One other survivor's voice connection (perfect negotiation: the polite end yields on a clash). */
class Peer {
  readonly pc: RTCPeerConnection;
  state: PeerState = 'connecting';
  talk: TalkMode | null = null;
  rtt: number | null = null;
  pos: Vec3 | null = null;
  /** Placed by the game in progress (alive or not); unplaced voices play flat. */
  placed = false;
  alive = true;
  private makingOffer = false;
  private ignoreOffer = false;
  private graph: Graph | null = null;
  private stream: MediaStream | null = null;
  private readonly buf = new Float32Array(512);
  private speakingUntil = 0;
  private muffleAt = 0;
  private restarts = 0;

  constructor(readonly id: string, public pid: string, public name: string, private readonly polite: boolean, private readonly voice: Voice) {
    this.pc = new RTCPeerConnection(voice.rtcConfig());
    const pc = this.pc;
    pc.onicecandidate = (e) => this.signal({ candidate: e.candidate ? e.candidate.toJSON() as RtcSignal['candidate'] : null });
    pc.onnegotiationneeded = () => void this.offer();
    pc.ontrack = (e) => this.attach(e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this.state = 'connected';
        this.restarts = 0;
        void this.tuneSender();
      } else if (s === 'failed') {
        // The impolite end restarts ICE (a fresh offer); after a few tries it is shown as failed.
        if (this.restarts++ < RESTARTS && !this.polite) pc.restartIce();
        else if (this.restarts > RESTARTS) this.state = 'failed';
      }
    };
    // The impolite end opens the audio line; the other answers on it.
    if (!polite) {
      const t = pc.addTransceiver(voice.track ?? 'audio', { direction: 'sendrecv' });
      preferOpus(t);
    }
  }

  private signal(s: RtcSignal): void {
    this.voice.send(C2S.rtc, { to: this.id, ...s });
  }

  private async offer(): Promise<void> {
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      if (this.pc.signalingState !== 'stable') return;
      await this.pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') });
      this.signal({ description: { type: 'offer', sdp: this.pc.localDescription?.sdp } });
    } catch (e) {
      console.warn('[voice] offer failed', e);
    } finally {
      this.makingOffer = false;
    }
  }

  async receive(m: RtcIn): Promise<void> {
    const pc = this.pc;
    try {
      if (m.description) {
        const d = m.description;
        const clash = d.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && clash;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(d as RTCSessionDescriptionInit);
        if (d.type === 'offer') {
          for (const t of pc.getTransceivers()) {
            if (t.receiver.track.kind !== 'audio') continue;
            if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
            if (this.voice.track && t.sender.track !== this.voice.track) await t.sender.replaceTrack(this.voice.track);
            preferOpus(t);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp ?? '') });
          this.signal({ description: { type: 'answer', sdp: pc.localDescription?.sdp } });
        }
      } else if (m.candidate !== undefined) {
        try {
          await pc.addIceCandidate(m.candidate ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn('[voice] negotiation', e);
    }
  }

  /** A higher priority and a bitrate cap for the voice going out (where the browser supports it). */
  private async tuneSender(): Promise<void> {
    for (const t of this.pc.getTransceivers()) {
      const p = t.sender.getParameters();
      if (!p.encodings?.length) continue;
      p.encodings = p.encodings.map((e) => ({ ...e, maxBitrate: 40000, priority: 'high', networkPriority: 'high' }));
      await t.sender.setParameters(p).catch(() => undefined);
    }
  }

  /** The microphone changed (or opened): send it on this connection without renegotiating. */
  async setTrack(track: MediaStreamTrack | null): Promise<void> {
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver.track.kind === 'audio' && t.sender.track !== track && (t.direction === 'sendrecv' || t.direction === 'sendonly')) {
        await t.sender.replaceTrack(track).catch(() => undefined);
      }
    }
  }

  private attach(stream: MediaStream): void {
    if (this.stream === stream) return;
    this.stream = stream;
    this.teardown();
    this.build();
  }

  /** The playback graph, once the audio context exists. */
  private build(): void {
    const ctx = audio.ctx;
    const out = audio.voiceOut;
    if (!this.stream || this.graph || !(ctx instanceof AudioContext) || !out) return;
    const el = new Audio();
    el.muted = true;
    el.srcObject = this.stream;
    void el.play().catch(() => undefined);
    const source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const user = ctx.createGain();
    const flat = ctx.createGain();
    const near = ctx.createGain();
    const wall = ctx.createBiquadFilter();
    wall.type = 'lowpass';
    wall.frequency.value = 20000;
    wall.Q.value = 0.5;
    const wallGain = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 2;
    panner.rolloffFactor = 1;
    panner.maxDistance = FADE_TO;
    const radio = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 450;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 127.5) - 1) * 2.2) / Math.tanh(2.2);
    drive.curve = curve;
    for (const g of [flat, near, radio]) g.gain.value = 0;
    source.connect(analyser);
    source.connect(user);
    user.connect(flat).connect(out);
    user.connect(wall).connect(wallGain).connect(near).connect(panner).connect(out);
    user.connect(hp).connect(lp).connect(drive).connect(radio).connect(out);
    this.graph = { el, source, analyser, user, flat, near, wall, wallGain, panner, radio };
  }

  private teardown(): void {
    const g = this.graph;
    if (!g) return;
    g.source.disconnect();
    for (const n of [g.user, g.flat, g.near, g.wall, g.wallGain, g.panner, g.radio]) n.disconnect();
    g.el.srcObject = null;
    this.graph = null;
  }

  get speaking(): boolean {
    return performance.now() / 1000 < this.speakingUntil;
  }

  get remoteStream(): MediaStream | null {
    return this.stream;
  }

  /** Levels, routing and walls, 25 times a second. */
  tick(now: number, inGame: boolean): void {
    if (!this.graph) this.build();
    const g = this.graph;
    if (!g || !audio.ctx) return;
    if (levelOf(g.analyser, this.buf) > SPEAKING_DB) this.speakingUntil = now + SPEAKING_HOLD;
    const t = audio.ctx.currentTime;
    g.user.gain.setTargetAtTime(comms.voiceMuted(this.pid) ? 0 : comms.volume(this.pid), t, 0.03);
    let flat = 0, near = 0, radio = 0;
    if (!inGame || !this.placed) flat = 1;
    // A survivor who has fallen still talks to the team, over the radio.
    else if (!this.alive || !this.pos) radio = 1;
    else {
      const l = audio.listener;
      const d = Math.hypot(this.pos.x - l.x, this.pos.y - l.y, this.pos.z - l.z);
      near = Math.min(1, Math.max(0, (FADE_TO - d) / (FADE_TO - FADE_FROM)));
      if (this.talk === 'radio') radio = 1;
      g.panner.positionX.setTargetAtTime(this.pos.x, t, 0.03);
      g.panner.positionY.setTargetAtTime(this.pos.y, t, 0.03);
      g.panner.positionZ.setTargetAtTime(this.pos.z, t, 0.03);
      if (near > 0 && now > this.muffleAt) {
        const m = audio.muffle(this.pos);
        g.wall.frequency.setTargetAtTime(m.cutoff, t, 0.05);
        g.wallGain.gain.setTargetAtTime(m.gain, t, 0.05);
        this.muffleAt = now + 0.2;
      }
    }
    if (!settings.value.voice.radio) radio = 0;
    g.flat.gain.setTargetAtTime(flat, t, 0.05);
    g.near.gain.setTargetAtTime(near, t, 0.05);
    g.radio.gain.setTargetAtTime(radio * 0.9, t, 0.02);
  }

  close(): void {
    this.teardown();
    this.pc.onicecandidate = this.pc.ontrack = this.pc.onnegotiationneeded = this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

/** What getStats() says about one voice connection. */
export interface VoiceStats {
  /** Network round trip on the chosen route (s). */
  rtt: number | null;
  /** Interarrival jitter of their audio (s). */
  jitter: number | null;
  packetsReceived: number;
  packetsLost: number;
  /** Average time their audio waits in the jitter buffer before playing (s). */
  jitterBuffer: number | null;
  /** Samples of their audio played so far, and how many were made up for lost or late packets (not silence). */
  samples: number;
  concealedSamples: number;
  bytesReceived: number;
  bytesSent: number;
  codec: string;
  /** host, srflx (through a router), prflx or relay (through TURN). */
  route: string;
}

/**
 * Proximity voice for one room: a WebRTC connection to every other survivor (negotiated through
 * the room), the microphone with the browser's echo cancellation, noise suppression and auto gain,
 * push-to-talk or voice activation, and each voice played from where that survivor stands (muffled
 * through walls), over the team radio, or flat in the lobby.
 */
export class Voice {
  readonly peers = new Map<string, Peer>();
  micState: MicState = 'off';
  /** Microphone level (dBFS), even while not sending. */
  micLevel = -100;
  /** What goes out now (null: nothing). */
  sending: TalkMode | null = null;
  private ice: IceConfig | null = null;
  private members: LobbyPlayer[] = [];
  private mic: MediaStream | null = null;
  /** The microphone track sent to everyone: enabled only while transmitting. */
  track: MediaStreamTrack | null = null;
  /** A copy of the track that stays on, for the level meter and voice activation. */
  private meter: { track: MediaStreamTrack; source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null = null;
  private readonly buf = new Float32Array(1024);
  private readonly held = { talk: false, radio: false };
  private vadUntil = 0;
  private inGame = false;
  /** Negotiation that arrived before the lobby listed its sender. */
  private pending: RtcIn[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  private readonly unsub: (() => void)[] = [];
  private micKey = '';
  private relayOnly: boolean;
  private disposed = false;

  constructor(private readonly myId: () => string, readonly send: (type: string, msg?: unknown) => void) {
    const opts = { signal: this.abort.signal };
    const key = (code: string, down: boolean) => {
      const b = settings.value.controls.bindings;
      if (b.talk.includes(code)) this.press('talk', down);
      if (b.radio.includes(code)) this.press('radio', down);
    };
    window.addEventListener('keydown', (e) => !e.repeat && !typing(e) && key(e.code, true), opts);
    window.addEventListener('keyup', (e) => key(e.code, false), opts);
    window.addEventListener('mousedown', (e) => key(`Mouse${e.button}`, true), opts);
    window.addEventListener('mouseup', (e) => key(`Mouse${e.button}`, false), opts);
    window.addEventListener('blur', () => {
      this.held.talk = this.held.radio = false;
    }, opts);
    this.micKey = this.micSettings();
    this.relayOnly = settings.value.voice.relayOnly;
    this.unsub.push(settings.subscribe(() => this.settingsChanged()), comms.subscribe(() => this.setMembers(this.members)));
    this.timer = setInterval(() => this.tick(), 40);
    this.statsTimer = setInterval(() => void this.measure(), 2000);
  }

  private micSettings(): string {
    const v = settings.value.voice;
    return `${v.device}|${v.echoCancellation}|${v.noiseSuppression}|${v.autoGainControl}`;
  }

  rtcConfig(): RTCConfiguration {
    const relay = settings.value.voice.relayOnly && !!this.ice?.relay;
    return { iceServers: this.ice?.iceServers ?? [], iceTransportPolicy: relay ? 'relay' : 'all', bundlePolicy: 'max-bundle' };
  }

  /** Whether this server offers a TURN relay. */
  get relayAvailable(): boolean {
    return !!this.ice?.relay;
  }

  setIce(cfg: IceConfig): void {
    if (!cfg || !Array.isArray(cfg.iceServers)) return;
    this.ice = cfg;
    this.setMembers(this.members);
  }

  /** Who is in the room: connect to newcomers, drop those who left or are blocked. */
  setMembers(players: LobbyPlayer[]): void {
    this.members = players;
    if (!this.ice || this.disposed) return;
    const me = this.myId();
    const on = settings.value.voice.enabled;
    const want = new Map(players.filter((p) => on && p.id !== me && !comms.blocked(p.pid)).map((p) => [p.id, p]));
    for (const [id, peer] of this.peers) {
      if (want.has(id)) continue;
      peer.close();
      this.peers.delete(id);
    }
    for (const [id, p] of want) {
      const peer = this.peers.get(id);
      if (peer) {
        peer.name = p.name;
        peer.pid = p.pid;
        continue;
      }
      this.peers.set(id, new Peer(id, p.pid, p.name, me > id, this));
    }
    const waiting = this.pending;
    this.pending = [];
    for (const m of waiting) this.signal(m);
  }

  signal(m: RtcIn): void {
    if (!m || typeof m.from !== 'string') return;
    const peer = this.peers.get(m.from);
    if (peer) void peer.receive(m);
    else if (this.pending.length < 64) this.pending.push(m);
  }

  remoteTalk(m: TalkMsg): void {
    const peer = this.peers.get(m?.id);
    if (!peer) return;
    const was = peer.talk;
    peer.talk = m.mode === 'near' || m.mode === 'radio' ? m.mode : null;
    // The squelch of a radio keying up or down.
    if (this.inGame && settings.value.voice.radio && peer.placed && peer.alive && (was === 'radio') !== (peer.talk === 'radio')) {
      this.squelch(peer.talk === 'radio');
    }
  }

  /** The game in progress places voices (null: the menu, lobby or results; everyone plays flat). */
  setInGame(on: boolean): void {
    this.inGame = on;
    if (!on) for (const p of this.peers.values()) p.placed = false;
  }

  /** Where a survivor's mouth is (null when gone), whether they are alive. */
  place(id: string, pos: Vec3 | null, alive: boolean): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.placed = true;
    p.alive = alive;
    if (!pos) p.pos = null;
    else if (p.pos) {
      p.pos.x = pos.x;
      p.pos.y = pos.y;
      p.pos.z = pos.z;
    } else p.pos = { x: pos.x, y: pos.y, z: pos.z };
  }

  speaking(id: string): boolean {
    if (id === this.myId()) return this.sending !== null && this.micLevel > SPEAKING_DB;
    return this.peers.get(id)?.speaking ?? false;
  }

  talkOf(id: string): TalkMode | null {
    return id === this.myId() ? this.sending : this.peers.get(id)?.talk ?? null;
  }

  stateOf(id: string): { state: PeerState; rtt: number | null } | null {
    const p = this.peers.get(id);
    return p ? { state: p.state, rtt: p.rtt } : null;
  }

  private press(kind: 'talk' | 'radio', down: boolean): void {
    this.held[kind] = down;
    if (down && settings.value.voice.enabled && this.micState === 'off') void this.startMic();
  }

  /** Asks for the microphone (the browser prompts the first time). */
  async startMic(): Promise<void> {
    if (this.micState === 'asking' || this.micState === 'on' || this.disposed) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micState = 'unsupported';
      return;
    }
    this.micState = 'asking';
    try {
      const stream = await openMic(settings.value.voice);
      if (this.disposed || !settings.value.voice.enabled) {
        for (const t of stream.getTracks()) t.stop();
        this.micState = 'off';
        return;
      }
      this.useTrack(stream.getAudioTracks()[0], stream);
    } catch {
      this.micState = 'denied';
    }
  }

  /** Sends this track as the microphone (also how tests feed a known signal). */
  useTrack(track: MediaStreamTrack, stream: MediaStream | null = null): void {
    this.stopMic();
    this.mic = stream;
    this.track = track;
    track.enabled = this.sending !== null;
    track.onended = () => {
      if (this.track === track) this.stopMic();
    };
    const ctx = audio.ctx;
    if (ctx instanceof AudioContext) {
      const copy = track.clone();
      copy.enabled = true;
      const source = ctx.createMediaStreamSource(new MediaStream([copy]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.meter = { track: copy, source, analyser };
    }
    this.micState = 'on';
    for (const p of this.peers.values()) void p.setTrack(track);
  }

  private stopMic(): void {
    if (this.meter) {
      this.meter.source.disconnect();
      this.meter.track.stop();
      this.meter = null;
    }
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.track?.stop();
    this.mic = null;
    this.track = null;
    this.micLevel = -100;
    this.micState = 'off';
    for (const p of this.peers.values()) void p.setTrack(null);
  }

  private settingsChanged(): void {
    const v = settings.value.voice;
    const key = this.micSettings();
    if (!v.enabled) this.stopMic();
    else if (key !== this.micKey && this.micState === 'on') {
      this.stopMic();
      void this.startMic();
    } else if (v.mode === 'vad' && this.micState === 'off') void this.startMic();
    this.micKey = key;
    if (v.relayOnly !== this.relayOnly) {
      this.relayOnly = v.relayOnly;
      for (const p of this.peers.values()) {
        p.pc.setConfiguration(this.rtcConfig());
        p.pc.restartIce();
      }
    }
    this.setMembers(this.members);
  }

  private tick(): void {
    const now = performance.now() / 1000;
    if (this.meter) this.micLevel = levelOf(this.meter.analyser, this.buf);
    const v = settings.value.voice;
    let mode: TalkMode | null = null;
    if (v.enabled && this.micState === 'on') {
      if (this.held.radio) mode = 'radio';
      else if (this.held.talk) mode = 'near';
      else if (v.mode === 'vad') {
        if (this.micLevel > v.threshold) this.vadUntil = now + VAD_HANG;
        if (now < this.vadUntil) mode = 'near';
      }
    } else if (v.enabled && v.mode === 'vad' && this.micState === 'off' && this.ice) void this.startMic();
    if (mode !== this.sending) {
      if (this.inGame && v.radio && (mode === 'radio') !== (this.sending === 'radio')) this.squelch(mode === 'radio');
      this.sending = mode;
      if (this.track) this.track.enabled = mode !== null;
      this.send(C2S.talk, mode);
    }
    for (const p of this.peers.values()) p.tick(now, this.inGame);
  }

  /** A short burst of radio static. */
  private squelch(on: boolean): void {
    const ctx = audio.ctx;
    const out = audio.voiceOut;
    if (!ctx || !out) return;
    const n = Math.round(ctx.sampleRate * 0.07);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) * (on ? 0.12 : 0.18);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = on ? 2400 : 1800;
    bp.Q.value = 1.2;
    src.connect(bp).connect(out);
    src.start();
  }

  /** Round trip of each connection, every two seconds (shown in the lobby). */
  private async measure(): Promise<void> {
    for (const p of this.peers.values()) {
      if (p.state !== 'connected') continue;
      const s = await this.stats(p.id);
      p.rtt = s?.rtt ?? null;
    }
  }

  async stats(id: string): Promise<VoiceStats | null> {
    const p = this.peers.get(id);
    if (!p) return null;
    const report = await p.pc.getStats();
    let transport: any = null, pairFallback: any = null, inbound: any = null, outbound: any = null;
    report.forEach((s: any) => {
      if (s.type === 'transport') transport = s;
      else if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || !pairFallback)) pairFallback = s;
      else if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
      else if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound = s;
    });
    const pair: any = (transport?.selectedCandidatePairId && report.get(transport.selectedCandidatePairId)) || pairFallback;
    const local: any = pair && report.get(pair.localCandidateId);
    const codec: any = inbound?.codecId && report.get(inbound.codecId);
    return {
      rtt: pair?.currentRoundTripTime ?? null,
      jitter: inbound?.jitter ?? null,
      packetsReceived: inbound?.packetsReceived ?? 0,
      packetsLost: inbound?.packetsLost ?? 0,
      jitterBuffer: inbound?.jitterBufferEmittedCount ? inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount : null,
      samples: inbound?.totalSamplesReceived ?? 0,
      concealedSamples: (inbound?.concealedSamples ?? 0) - (inbound?.silentConcealedSamples ?? 0),
      bytesReceived: inbound?.bytesReceived ?? 0,
      bytesSent: outbound?.bytesSent ?? 0,
      codec: codec ? `${codec.mimeType} ${codec.sdpFmtpLine ?? ''}`.trim() : '',
      route: local?.candidateType ?? '',
    };
  }

  /** Their audio as received (tests measure it). */
  remoteStream(id: string): MediaStream | null {
    return this.peers.get(id)?.remoteStream ?? null;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    clearInterval(this.statsTimer);
    this.abort.abort();
    for (const u of this.unsub) u();
    if (this.sending) this.send(C2S.talk, null);
    this.stopMic();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }
}
