"""Builds the recorded gun and flesh-hit sounds in client/src/audio/recorded/ from Freesound recordings
(CC0, listed in SOURCES with the time of each shot used). Freesound serves its high-quality previews
without a login; the originals need one. Needs numpy and ffmpeg (with libmp3lame).

Usage: python3 -I make_recorded_sounds.py DOWNLOAD_DIR OUT_DIR [REPORT.json]
Downloads any preview missing from DOWNLOAD_DIR first."""
import json, os, subprocess, sys
import numpy as np

SR = 48000
dl, out = sys.argv[1], sys.argv[2]
report_path = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(dl, exist_ok=True)
os.makedirs(out, exist_ok=True)

# Freesound id -> (preview URL, author, title). Every one is Creative Commons 0.
SOURCES = {
    731942: ('https://cdn.freesound.org/previews/731/731942_15161028-hq.ogg', 'DledeSOUND', '9mm Pistol Gunshots'),
    427598: ('https://cdn.freesound.org/previews/427/427598_3094998-hq.ogg', 'michorvath', 'AR15 pistol shot'),
    450853: ('https://cdn.freesound.org/previews/450/450853_612689-hq.ogg', 'kyles', 'gun lee enfield 303 rifle clean shot'),
    619041: ('https://cdn.freesound.org/previews/619/619041_781461-hq.ogg', 'mrrap4food', 'Shot Gun - 12 Gauge- Fire Four Shots Quickly'),
    423301: ('https://cdn.freesound.org/previews/423/423301_8202639-hq.ogg', 'u1769092', 'VisceralBulletImpacts'),
    495118: ('https://cdn.freesound.org/previews/495/495118_2723982-hq.ogg', 'nebulasnails', 'Wet Splat 1'),
    511194: ('https://cdn.freesound.org/previews/511/511194_5701403-hq.ogg', 'Pablobd', 'Headshot'),
    641040: ('https://cdn.freesound.org/previews/641/641040_11537497-hq.ogg', 'magnuswaker', 'GROSS IMPACT'),
    399183: ('https://cdn.freesound.org/previews/399/399183_3287894-hq.ogg', 'janbezouska', 'Major punch'),
    702225: ('https://cdn.freesound.org/previews/702/702225_15072041-hq.ogg', 'areniporgen', 'FN SCAR-H'),
    169170: ('https://cdn.freesound.org/previews/169/169170_1050391-hq.ogg', 'kvgarlic', '50CaliberOnePigRoast2012'),
    668071: ('https://cdn.freesound.org/previews/668/668071_7842170-hq.ogg', 'ajhartman42295', '50 cal shot'),
    629008: ('https://cdn.freesound.org/previews/629/629008_433447-hq.ogg', 'realgtro', 'flashlight click'),
}
# Recordings whose loudest moments were clipped (flat-topped): repaired before use.
CLIPPED = {702225, 668071}

def source(fid):
    path = os.path.join(dl, f'{fid}.ogg')
    if not os.path.exists(path):
        subprocess.run(['curl', '-s', '-f', '-m', '60', '-o', path, SOURCES[fid][0]], check=True)
    fix = ['-af', 'adeclip'] if fid in CLIPPED else []
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, *fix, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()

def onset(x, near, search=0.3, below=20):
    """First sample within `search` s of `near` where the 1 ms envelope comes within `below` dB of that region's peak."""
    a = max(0, int((near - search) * SR)); b = min(len(x), int((near + search) * SR))
    seg = np.abs(x[a:b])
    env = np.convolve(seg, np.ones(48) / 48, mode='same')
    i = int(np.argmax(env > env.max() * 10 ** (-below / 20)))
    return a + i

def resample(x, rate):
    """Pitch by `rate` (1.02 = 2 % up, and 2 % shorter)."""
    if abs(rate - 1) < 1e-4: return x
    n = int(len(x) / rate)
    return np.interp(np.arange(n) * rate, np.arange(len(x)), x).astype(np.float32)

def ffmpeg_chain(x, chain):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', chain, '-f', 'f32le', '-'],
                       input=x.astype(np.float32).tobytes(), capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).copy()

def finish(x, name, length, fade_from, low_gain, bark, drive, rate=1.0, tilt=0.0):
    """Trim, EQ (low shelf for body, a peak for the bark, a gentle tilt per take), fade the tail, limit, peak to -1 dBFS, MP3."""
    x = resample(x, rate)[:int(length * SR)]
    n = len(x)
    chain = ','.join([
        'highpass=f=28:poles=2',
        f'lowshelf=f=120:g={low_gain}',
        f'equalizer=f={bark[0]}:t=q:w=1.1:g={bark[1]}',
        f'treble=f=6000:g={tilt}',
        'afade=t=in:d=0.0015',
        f'afade=t=out:st={fade_from * n / SR:.4f}:d={(1 - fade_from) * n / SR:.4f}:curve=exp',
        f'alimiter=level_in={10 ** (drive / 20):.3f}:limit=0.93:attack=0.3:release=60:level=false',
    ])
    y = ffmpeg_chain(x, chain)[:n]
    y = y / (np.abs(y).max() + 1e-9) * 10 ** (-1 / 20)
    path = os.path.join(out, f'{name}.mp3')
    # MP3, and resampling to a 44.1 kHz device, can overshoot a hard-limited transient by a dB or
    # more: encode again lower until it decodes under -0.4 dBFS at both rates.
    for _ in range(4):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', '160k', path],
                       input=y.astype(np.float32).tobytes(), check=True)
        peak = max(np.abs(np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(rate), '-'],
                                                       capture_output=True, check=True).stdout, dtype=np.float32)).max() for rate in (SR, 44100))
        if peak <= 0.955: break
        y = y * (0.89 / peak)
    return y

made = {}
def take(name, fid, at, **kw):
    x = source(fid)
    o = onset(x, at)
    pre = int(0.003 * SR)
    y = finish(x[max(0, o - pre):], name, **kw)
    made[name] = dict(source=fid, at=round(o / SR, 3), **{k: v for k, v in kw.items() if k in ('rate', 'tilt', 'length')})
    return y

# M17 (9 mm): four shots from the same string at an outdoor range.
for i, t in enumerate([0.803, 3.717, 5.588, 8.187]):
    take(f'pistol-{i}', 731942, t, length=0.95, fade_from=0.35, low_gain=4, bark=(1800, 2), drive=5, tilt=[0, -1, 1, 0][i])
# MP5 (9 mm too): the fifth shot and two of the others, shorter and barkier, a little less low end than the pistol.
for i, (t, r) in enumerate([(9.386, 1.0), (3.717, 1.025), (5.588, 0.985), (0.803, 1.012)]):
    take(f'smg-{i}', 731942, t, length=0.6, fade_from=0.3, low_gain=2, bark=(2400, 3), drive=5, rate=r, tilt=1)
# M4A1 (5.56): one clean AR-15 shot, four takes a couple of percent apart in pitch and brightness.
for i, (r, tl) in enumerate([(1.0, 0), (1.022, 1), (0.982, -1), (1.01, 0.5)]):
    take(f'ar-{i}', 427598, 0.03, length=0.88, fade_from=0.4, low_gain=4, bark=(2200, 2), drive=5, rate=r, tilt=tl)
# MK14 (7.62 NATO): a .303 service rifle, the nearest clean full-power rifle recording; long rolling tail.
for i, (r, tl) in enumerate([(1.0, 0), (1.02, 0.5), (0.98, -0.5), (1.01, 0)]):
    take(f'marksman-{i}', 450853, 0.02, length=1.8, fade_from=0.35, low_gain=5, bark=(1500, 1.5), drive=4, rate=r, tilt=tl)
# M870 (12 gauge): four shots fired quickly; the first three are cut short by the next, so each borrows the last one's tail.
sg = source(619041)
starts = [onset(sg, t) for t in (0.24, 0.79, 1.37, 1.84)]
tail_from = int(0.42 * SR)
last = sg[starts[3] - int(0.003 * SR):]
for i, s in enumerate(starts):
    head = sg[s - int(0.003 * SR):]
    if i < 3:
        cut = min(len(head), tail_from + int(0.06 * SR))
        mix = last.copy()[:max(len(last), cut)]
        w = np.clip((np.arange(len(mix)) - tail_from) / (0.06 * SR), 0, 1).astype(np.float32)
        mix[:cut] = head[:cut] * (1 - w[:cut]) + mix[:cut] * w[:cut]
        head = mix
    finish(head, f'shotgun-{i}', length=1.3, fade_from=0.35, low_gain=6, bark=(900, 2), drive=4)
    made[f'shotgun-{i}'] = dict(source=619041, at=round(s / SR, 3), length=1.3)

# SCAR-H (7.62 NATO): the single shot that opens a recording of one, outdoors, before its full-auto burst.
for i, (r, tl) in enumerate([(1.0, 0), (1.02, 0.5), (0.98, -0.5), (1.01, -1)]):
    take(f'battle-{i}', 702225, 0.02, length=1.3, fade_from=0.35, low_gain=5, bark=(1700, 1.5), drive=4, rate=r, tilt=tl)
# M107 (.50 BMG): two shots of a Barrett in an open field with its rolling echo, and one .50 BMG shot at
# a range with the case landing.
for i, (fid, t, r) in enumerate([(169170, 14.208, 1.0), (169170, 25.264, 1.0), (668071, 0.014, 1.0), (169170, 14.208, 0.97)]):
    take(f'sniper-{i}', fid, t, length=2.0, fade_from=0.4, low_gain=6, bark=(1100, 1.5), drive=4, rate=r)

# Bullets into flesh: designed impacts (from the hit on, without their build-up), a wet splat, a head hit, a punch.
fl = source(423301)
for i, t in enumerate([0.10, 0.75, 1.49, 2.21]):
    a = max(0, int((t - 0.05) * SR)); b = int((t + 0.45) * SR)
    pk = a + int(np.argmax(np.abs(fl[a:b])))
    seg = fl[pk - int(0.004 * SR):]
    finish(seg, f'flesh-{i}', length=0.22, fade_from=0.3, low_gain=5, bark=(700, 2), drive=4)
    made[f'flesh-{i}'] = dict(source=423301, at=round(pk / SR, 3), length=0.22)
take('wet-0', 495118, 0.07, length=0.5, fade_from=0.25, low_gain=2, bark=(1000, 1), drive=2)
take('wet-1', 641040, 0.01, length=0.45, fade_from=0.25, low_gain=2, bark=(1200, 1), drive=2)
take('head-0', 511194, 0.07, length=0.6, fade_from=0.3, low_gain=3, bark=(2500, 2), drive=3)
take('punch-0', 399183, 0.10, length=0.4, fade_from=0.3, low_gain=3, bark=(800, 1), drive=3)

# Flashlight: a clicky tailcap switch pressed and let go, three times (each take holds both clicks).
fla = source(629008)
for i, t in enumerate([0.172, 1.846, 3.244]):
    o = onset(fla, t, search=0.04)
    finish(fla[o - int(0.003 * SR):], f'torch-{i}', length=0.24, fade_from=0.65, low_gain=0, bark=(3000, 0), drive=0)
    made[f'torch-{i}'] = dict(source=629008, at=round(o / SR, 3), length=0.24)

credits = {str(k): dict(url=f'https://freesound.org/s/{k}/', author=v[1], title=v[2], license='CC0 1.0') for k, v in SOURCES.items()}
if report_path:
    json.dump(dict(made=made, credits=credits), open(report_path, 'w'), indent=1)
total = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out) if f.endswith('.mp3'))
print(f'{len(made)} sounds, {total // 1024} KB')
