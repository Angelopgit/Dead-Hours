#!/usr/bin/env python3
"""
The trailer's score, synthesized to fit the cut: a low D minor drone that opens with the tension
of each shot, a slow pulse under the fights, a hit on every title card, a riser into the title.
Reads manifest.json and cards.json (what assemble.mjs lays over which shot) and writes score.wav.

    python3 -I client/tools/trailer/score.py OUT_DIR
"""
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
out = Path(sys.argv[1])
manifest = json.loads((out / 'manifest.json').read_text())
cards = json.loads((out / 'cards.json').read_text()) if (out / 'cards.json').exists() else []
fps = manifest['fps']
frames = manifest['frames']
seconds = frames / fps
n = int(seconds * SR)
t = np.arange(n) / SR
rng = np.random.default_rng(7)

# Tension over time, from the shots (held, then eased), and where each shot starts.
TENSION = {
    'street': 0.15, 'stand': 0.6, 'horde-pov': 0.8, 'windows': 0.55, 'fire': 0.75, 'drive': 0.7, 'drop': 0.4,
    'raid': 0.85, 'horde': 1.0, 'revive': 0.45, 'walk': 0.3, 'title': 0.35,
}
tension = np.zeros(n)
starts = []
for s in manifest['shots']:
    a, b = int(s['from'] / fps * SR), int((s['to'] + 1) / fps * SR)
    tension[a:b] = TENSION.get(s['name'], 0.5)
    starts.append((s['name'], s['from'] / fps, (s['to'] + 1) / fps))
# Smooth it (one-pole, ~1.5 s).
k = 1 - math.exp(-1 / (SR * 1.5))
sm = np.empty(n)
acc = tension[0]
for i in range(n):  # slow in Python? n is ~3.6M: use lfilter-free vectorized trick below instead
    break
# Vectorized exponential smoothing via cumulative formula on blocks of 1024 samples.
blk = 1024
tb = tension[: (n // blk) * blk].reshape(-1, blk).mean(axis=1)
smb = np.empty_like(tb)
acc = tb[0]
kb = 1 - math.exp(-blk / (SR * 1.5))
for i, v in enumerate(tb):
    acc += (v - acc) * kb
    smb[i] = acc
sm = np.interp(t, (np.arange(len(smb)) + 0.5) * blk / SR, smb)


def env(attack, hold, release, length):
    """A one-shot envelope."""
    m = int(length * SR)
    x = np.arange(m) / SR
    e = np.ones(m)
    e[: int(attack * SR)] = np.linspace(0, 1, int(attack * SR))
    r0 = int((attack + hold) * SR)
    if r0 < m:
        e[r0:] = np.exp(-(x[r0:] - x[r0]) / max(release, 1e-3))
    return e


def lowpass(x, cutoff):
    """One-pole low-pass (the drone's warmth)."""
    a = math.exp(-2 * math.pi * cutoff / SR)
    y = np.empty_like(x)
    # Vectorized IIR via scipy-free recursion in chunks (fast enough for a few passes).
    acc = 0.0
    for i in range(0, len(x), blk):
        seg = x[i:i + blk]
        o = np.empty_like(seg)
        for j in range(len(seg)):
            acc = seg[j] * (1 - a) + acc * a
            o[j] = acc
        y[i:i + blk] = o
    return y


def add(mix, at, sound, gain=1.0):
    i = int(at * SR)
    if i >= n:
        return
    m = min(len(sound), n - i)
    mix[i:i + m] += sound[:m] * gain


mix = np.zeros(n)

# Drone: D1 and A1, detuned saws through a slow-breathing low-pass, opening with the tension.
drone = np.zeros(n)
for f, g in ((36.71, 0.5), (36.9, 0.4), (55.0, 0.3), (73.4, 0.12), (110.0, 0.05)):
    ph = (t * f) % 1.0
    drone += (2 * ph - 1) * g
breath = 0.5 + 0.5 * np.sin(2 * math.pi * 0.045 * t)
drone = lowpass(drone, 120)
drone_hi = lowpass(drone, 90 + 280 * sm.mean())
drone = drone * (0.55 + 0.45 * breath) * (0.5 + 0.9 * sm)
mix += drone * 0.22

# A slow pulse (two low thumps, like a heartbeat) under the fights.
beat = 60 / 92
thump = np.sin(2 * math.pi * np.cumsum(np.linspace(62, 34, int(0.28 * SR))) / SR) * env(0.004, 0.02, 0.12, 0.28)
tt = 0.0
while tt < seconds:
    g = float(np.interp(tt, t[::1000], sm[::1000]))
    if g > 0.45:
        add(mix, tt, thump, 0.7 * (g - 0.3))
        add(mix, tt + beat * 0.32, thump, 0.4 * (g - 0.3))
    tt += beat

# A quiet eerie pad on the calm shots: D5, F5, A5 sines with slow tremolo.
pad = np.zeros(n)
for f, g, r in ((587.33, 0.5, 0.21), (698.46, 0.35, 0.17), (880.0, 0.25, 0.13)):
    pad += np.sin(2 * math.pi * f * t + 0.3 * np.sin(2 * math.pi * 0.07 * t)) * g * (0.6 + 0.4 * np.sin(2 * math.pi * r * t))
mix += pad * 0.012 * (1 - sm)

# Hits: on every card and every shot start, scaled with tension; the title's is the biggest.
noise = rng.standard_normal(int(2.5 * SR))
tail = lowpass(noise, 900) * env(0.01, 0.05, 0.55, 2.5)
sub = np.sin(2 * math.pi * np.cumsum(np.linspace(95, 38, int(1.6 * SR))) / SR) * env(0.003, 0.08, 0.5, 1.6)
crack = lowpass(rng.standard_normal(int(0.12 * SR)), 4000) * env(0.001, 0.01, 0.03, 0.12)
hit = np.zeros(int(2.5 * SR))
hit[: len(sub)] += sub * 0.9
hit += tail * 0.35
hit[: len(crack)] += crack * 0.25
for name, a, b in starts:
    g = TENSION.get(name, 0.5)
    if name == 'title':
        add(mix, a, hit, 1.0)
    elif name != 'street':
        add(mix, a, hit, 0.35 + 0.35 * g)
for c in cards:
    if c.get('kind') == 'feature':
        add(mix, c['at'], hit, 0.3)

# Riser into the title: filtered noise climbing over the last 3.5 s before it.
title = next((s for s in starts if s[0] == 'title'), None)
if title:
    L = 3.5
    m = int(L * SR)
    x = np.arange(m) / SR
    sweep = rng.standard_normal(m)
    # Rising band: a resonant sweep done as a mix of low-passed noise with a rising cutoff.
    r = np.zeros(m)
    for i in range(0, m, blk):
        seg = sweep[i:i + blk]
        cutoff = 200 + 3800 * (i / m) ** 2
        a = math.exp(-2 * math.pi * cutoff / SR)
        acc = 0.0
        o = np.empty_like(seg)
        for j in range(len(seg)):
            acc = seg[j] * (1 - a) + acc * a
            o[j] = acc
        r[i:i + blk] = o
    r *= (x / L) ** 2.2
    # A rising tone under it.
    r += np.sin(2 * math.pi * np.cumsum(np.linspace(55, 220, m)) / SR) * (x / L) ** 3 * 0.5
    add(mix, title[1] - L, r, 0.5)
    # Silence under the title's first beat, then the drone comes back.
    cut0, cut1 = int(title[1] * SR), int((title[1] + 0.35) * SR)
    mix[cut0:cut1] *= np.linspace(1, 0.15, cut1 - cut0) ** 0.5

# The end: fade out over the last 2 s.
fade = int(2 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)
# Gentle soft clip and level.
peak = np.max(np.abs(mix)) or 1
mix = np.tanh(mix / peak * 1.6) / math.tanh(1.6) * 0.7
stereo = np.stack([mix, mix], axis=1)
with wave.open(str(out / 'score.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(stereo, -1, 1) * 32767).astype('<i2').tobytes())
print(f'score.wav: {seconds:.1f}s, peak {20 * math.log10(np.max(np.abs(mix))):.1f} dBFS')
