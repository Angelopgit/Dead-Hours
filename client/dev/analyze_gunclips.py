"""Measures gun clips saved from dev/gunclips.html (C50, ring time, centroid, fly-by timing), draws spectrogram sheets
and joins each gun's four spaces into one A/B file. Needs numpy and Pillow. Usage: python3 -I analyze_gunclips.py CLIPDIR OUTDIR"""
import sys, os, wave, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

clipdir, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)

def load(path):
    with wave.open(path) as w:
        sr = w.getframerate(); n = w.getnframes(); ch = w.getnchannels()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32767
    return x.reshape(-1, ch), sr

def bandpass_energy(mono, sr, lo, hi, win):
    # Short-time energy in a band, via FFT frames.
    hop = win // 4
    frames = []
    for i in range(0, len(mono) - win, hop):
        spec = np.abs(np.fft.rfft(mono[i:i + win] * np.hanning(win))) ** 2
        f = np.fft.rfftfreq(win, 1 / sr)
        frames.append(spec[(f >= lo) & (f < hi)].sum())
    return np.array(frames), hop

def onset(env, hop, sr, frac=0.1):
    idx = np.argmax(env > env.max() * frac)
    return idx * hop / sr

def measure(x, sr):
    mono = x.mean(axis=1)
    peak = float(np.abs(x).max())
    e = mono ** 2
    total = e.sum() + 1e-12
    first = max(0, int(np.argmax(np.abs(mono) > peak * 0.05)))
    # C50 clarity: energy in the first 50 ms after arrival against everything later.
    direct = e[first:first + int(0.05 * sr)].sum()
    late = e[first + int(0.05 * sr):].sum()
    # Schroeder decay of the whole clip from its onset: time to fall 30 dB (x2 = T60 estimate).
    sch = np.cumsum(e[first:][::-1])[::-1]
    db = 10 * np.log10(sch / sch[0] + 1e-12)
    t5 = np.argmax(db < -5) / sr; t35 = np.argmax(db < -35) / sr
    spec = np.abs(np.fft.rfft(mono[first:first + int(0.3 * sr)])) ** 2
    f = np.fft.rfftfreq(len(mono[first:first + int(0.3 * sr)]), 1 / sr)
    centroid = float((spec * f).sum() / (spec.sum() + 1e-12))
    return {
        'peak_dbfs': float(round(20 * np.log10(peak + 1e-9), 1)),
        'arrival_ms': float(round(first / sr * 1000, 1)),
        'c50_db': float(round(10 * np.log10((direct + 1e-12) / (late + 1e-12)), 1)),
        'ring_t60_s': float(round((t35 - t5) * 2, 2)) if t35 > t5 else None,
        'centroid_hz': float(round(centroid)),
    }

def spectrogram(mono, sr, w=520, h=150):
    win = 1024; hop = max(1, len(mono) // w)
    cols = []
    for i in range(0, len(mono) - win, hop):
        s = np.abs(np.fft.rfft(mono[i:i + win] * np.hanning(win)))
        cols.append(20 * np.log10(s + 1e-7))
    S = np.array(cols).T  # freq x time
    f = np.fft.rfftfreq(win, 1 / sr)
    # Log-frequency rows from 40 Hz to 16 kHz.
    rows = np.geomspace(40, 16000, h)[::-1]
    idx = np.clip(np.searchsorted(f, rows), 0, len(f) - 1)
    img = S[idx]
    img = np.clip((img - (img.max() - 80)) / 80, 0, 1)
    rgb = np.stack([img ** 0.6 * 255, img ** 1.4 * 200, (1 - img) * img * 4 * 120], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb).resize((w, h))

results = {}
names = sorted(n[:-4] for n in os.listdir(clipdir) if n.endswith('.wav'))
for n in names:
    x, sr = load(os.path.join(clipdir, n + '.wav'))
    results[n] = measure(x, sr)

# Fly-by: the crack (above 3 kHz) arrives before the report (below 1 kHz).
for n in names:
    if 'flyby' not in n: continue
    x, sr = load(os.path.join(clipdir, n + '.wav'))
    mono = x.mean(axis=1)
    hi, hop = bandpass_energy(mono, sr, 3000, 16000, 256)
    full, _ = bandpass_energy(mono, sr, 60, 16000, 256)
    crack = int(np.argmax(hi > hi.max() * 0.05))
    # The crack is a few ms long: skip to where it has died away, then find the report's onset.
    quiet = crack + int(np.argmax(full[crack:] < full.max() * 0.001))
    report = quiet + int(np.argmax(full[quiet:] > full[quiet:].max() * 0.02))
    results[n]['crack_ms'] = float(round(crack * hop / sr * 1000, 1))
    results[n]['report_ms'] = float(round(report * hop / sr * 1000, 1))

json.dump(results, open(os.path.join(outdir, 'measurements.json'), 'w'), indent=1)

def sheet(title, items, path):
    pad, lw, w, h, wh = 8, 210, 520, 150, 44
    img = Image.new('RGB', (lw + w + pad * 2, len(items) * (h + wh + pad) + 40), (16, 14, 14))
    d = ImageDraw.Draw(img)
    d.text((pad, 10), title, fill=(230, 220, 200))
    for i, n in enumerate(items):
        x, sr = load(os.path.join(clipdir, n + '.wav'))
        y = 36 + i * (h + wh + pad)
        mono = x.mean(axis=1)
        # Waveform strip, scaled to the clip's peak: per-column min and max of the samples.
        cols = np.array_split(mono / (np.abs(mono).max() + 1e-9), w)
        for c, seg in enumerate(cols):
            lo_, hi_ = float(seg.min()), float(seg.max())
            d.line([(lw + pad + c, y + wh // 2 - hi_ * wh / 2), (lw + pad + c, y + wh // 2 - lo_ * wh / 2)], fill=(150, 200, 230))
        img.paste(spectrogram(mono, sr, w, h), (lw + pad, y + wh))
        m = results[n]
        d.text((pad, y + 4), n, fill=(240, 180, 110))
        d.text((pad, y + 24), f"peak {m['peak_dbfs']:.1f} dBFS", fill=(200, 200, 200))
        d.text((pad, y + 40), f"C50 {m['c50_db']:.1f} dB", fill=(200, 200, 200))
        d.text((pad, y + 56), f"ring {m['ring_t60_s']} s", fill=(200, 200, 200))
        d.text((pad, y + 72), f"centroid {m['centroid_hz']:.0f} Hz", fill=(200, 200, 200))
        if 'crack_ms' in m:
            d.text((pad, y + 88), f"crack {m['crack_ms']:.1f} ms, report {m['report_ms']:.1f} ms", fill=(200, 200, 200))
        for t in range(0, 3):
            xx = lw + pad + int(t / (len(x) / sr) * w)
            d.line([(xx, y + wh + h - 6), (xx, y + wh + h)], fill=(255, 255, 255))
    img.save(path)

for gun in ['ar', 'smg', 'shotgun', 'marksman', 'pistol']:
    sheet(f'{gun}: your own shot in four spaces (40 Hz-16 kHz, log; 0-2.6 s)', [f'{gun}-{s}' for s in ['street', 'room', 'basement', 'store']], os.path.join(outdir, f'spectrogram-{gun}.png'))
others = [n for n in names if n.count('-') > 1 and not any(n == f'{g}-{s}' for g in ['ar'] for s in [])]
others = [n for n in names if not any(n == f'{g}-{s}' for g in ['ar', 'smg', 'shotgun', 'marksman', 'pistol'] for s in ['street', 'room', 'basement', 'store'])]
sheet('Heard from elsewhere: distance, walls, fly-by crack', others, os.path.join(outdir, 'spectrogram-situations.png'))

# A/B per gun: street, room, basement, store, each followed by half a second of silence.
for gun in ['ar', 'smg', 'shotgun', 'marksman', 'pistol']:
    parts = []
    for s in ['street', 'room', 'basement', 'store']:
        x, sr = load(os.path.join(clipdir, f'{gun}-{s}.wav'))
        parts += [x, np.zeros((sr // 2, x.shape[1]), dtype=np.float32)]
    y = np.concatenate(parts)
    with wave.open(os.path.join(outdir, f'ab-{gun}-street-room-basement-store.wav'), 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())

for n in names: print(n.ljust(34), json.dumps(results[n]))
