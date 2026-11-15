"""Draws the training video from the story the app wrote (js/recap.js): every output frame is
described there (which clip and frame, where the camera sits, the words, the skeleton), so this file
only decodes, draws and encodes. 1080x1920 at 30 fps, H.264, with one music track mixed in.

python recap_render.py story.json out.mp4 clip0.mov [clip1.mov ...] [--music track.wav]
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.environ.get("RECAP_FONTS", os.path.join(HERE, "fonts"))
COL = {"ink": (243, 239, 230), "acc": (200, 242, 90), "warn": (255, 179, 71), "blk": (0, 0, 0)}
J = ['nose', 'lear', 'rear', 'lsho', 'rsho', 'lelb', 'relb', 'lwri', 'rwri', 'lhip', 'rhip', 'lknee', 'rknee', 'lank', 'rank', 'lheel', 'rheel', 'lbigtoe', 'rbigtoe', 'lsmalltoe', 'rsmalltoe']
I = {n: i for i, n in enumerate(J)}
# drawn from the hips out, so the skeleton reads like a body
BONES = [('lhip', 'rhip'), ('lsho', 'lhip'), ('rsho', 'rhip'), ('lsho', 'rsho'), ('lhip', 'lknee'), ('rhip', 'rknee'), ('lknee', 'lank'), ('rknee', 'rank'),
         ('lsho', 'lelb'), ('rsho', 'relb'), ('lelb', 'lwri'), ('relb', 'rwri'), ('lank', 'lheel'), ('lheel', 'lbigtoe'), ('lank', 'lbigtoe'), ('rank', 'rheel'), ('rheel', 'rbigtoe'), ('rank', 'rbigtoe')]

_font_cache = {}


def font(kind, size):
    key = (kind, size)
    if key not in _font_cache:
        if kind == "B":
            f = ImageFont.truetype(os.path.join(FONTS, "Oswald.ttf"), size)
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                pass
        else:
            f = ImageFont.truetype(os.path.join(FONTS, "BarlowSemiCondensed-SemiBold.ttf"), size)
        _font_cache[key] = f
    return _font_cache[key]


# ---------------- per-process state (the pool's workers) ----------------
S = {}


def init(story_path, frame_dirs, out_wh):
    S["story"] = json.load(open(story_path))
    S["dirs"] = frame_dirs
    W, H = out_wh
    S["W"], S["H"] = W, H
    yy, xx = np.mgrid[0:H, 0:W]
    S["vig"] = (1 - 0.55 * (((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H * 0.48) / (H * 0.62)) ** 2)).clip(0.35, 1)[..., None].astype(np.float32)
    S["cache"] = {}


def src(c, f):
    key = (c, f)
    cache = S["cache"]
    if key not in cache:
        if len(cache) > 24:
            cache.clear()
        cache[key] = Image.open(os.path.join(S["dirs"][c], f"{f:05d}.jpg")).convert("RGB")
    return cache[key]


def kp_of(c, f):
    k = S["story"]["clips"][c]["kp"].get(str(f))
    return k


def crop(p, region):
    """the clip frame cropped around (cx, cy) at zoom z to region (w, h); returns image and point transform"""
    img0 = src(p["c"], p["f"])
    SW, SH = img0.size
    rw, rh = region
    cw = SW / p.get("z", 2.0)
    ch = cw * rh / rw
    if ch > SH:
        ch = SH; cw = ch * rw / rh
    yb = p.get("yb", 0.5)
    x0 = min(max(p["cx"] - cw / 2, 0), SW - cw)
    y0 = min(max(p["cy"] - ch * yb, 0), SH - ch)
    box = (int(x0), int(y0), int(x0 + cw), int(y0 + ch))
    img = img0.crop(box).resize((rw, rh), Image.BICUBIC)
    s = rw / (box[2] - box[0])
    return img, (lambda q: ((q[0] - box[0]) * s, (q[1] - box[1]) * s))


def grade(img, dark=0.0):
    a = np.asarray(img).astype(np.float32)
    a = (a - 118) * 1.14 + 122
    a[..., 0] *= 1.03
    a[..., 2] *= 0.96
    H, W = a.shape[:2]
    vig = S["vig"] if (W, H) == (S["W"], S["H"]) else 1.0
    a = a * vig * (1 - dark)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def skeleton(base, kp, T, alpha=1.0, col="ink", glow="acc", width=7):
    if not kp or alpha <= 0:
        return base
    def P(n):
        k = I[n] * 3
        x, y, s = kp[k], kp[k + 1], kp[k + 2]
        if x is None or y is None or (s is not None and s < 0.3):
            return None
        return T((x, y))
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = int(255 * alpha)
    c = COL.get(col, COL["ink"])
    for na, nb in BONES:
        p, q = P(na), P(nb)
        if p and q:
            d.line([p, q], fill=c + (a,), width=width)
    for n in J[3:15]:
        p = P(n)
        if p:
            d.ellipse([p[0] - width, p[1] - width, p[0] + width, p[1] + width], fill=c + (a,))
    out = base.convert("RGBA")
    if glow != "none":
        small = layer.resize((base.size[0] // 3, base.size[1] // 3)).filter(ImageFilter.GaussianBlur(5))
        halo = Image.new("RGBA", small.size, COL.get(glow, COL["acc"]) + (0,))
        halo.putalpha(small.getchannel("A").point(lambda v: min(255, v * 2)))
        out.alpha_composite(halo.resize(base.size))
    out.alpha_composite(layer)
    return out.convert("RGB")


def arc(img, kp, T, spec):
    def P(n):
        k = I[n] * 3
        return None if kp[k] is None else T((kp[k], kp[k + 1]))
    A, B, C = P(spec["a"]), P(spec["b"]), P(spec["c"])
    if not (A and B and C):
        return img
    t1 = math.degrees(math.atan2(A[1] - B[1], A[0] - B[0])); t2 = math.degrees(math.atan2(C[1] - B[1], C[0] - B[0]))
    lo, hi = sorted((t1, t2))
    if hi - lo > 180:
        lo, hi = hi, lo + 360
    d = ImageDraw.Draw(img); r = 70
    d.arc([B[0] - r, B[1] - r, B[0] + r, B[1] + r], lo, hi, fill=COL["acc"], width=6)
    d.text((B[0] + 85, B[1] - 30), spec["t"], font=font("B", 84), fill=COL["acc"])
    return img


def words(img, items):
    if not items:
        return img
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    W = img.size[0]
    for w in items:
        a = float(w.get("a", 1))
        if a <= 0 or not w.get("t"):
            continue
        size = int(w.get("s", 60))
        fnt = font(w.get("f", "B"), size)
        al = w.get("al", "l")
        x = W / 2 if w["x"] == "c" else float(w["x"])
        anchor = {"l": "la", "c": "ma", "r": "ra"}["c" if w["x"] == "c" else al]
        # never past the edges: shrink to fit the room this anchor leaves
        room = W - 100 if w["x"] == "c" else (W - x - 50 if al == "l" else x - 50)
        tw = d.textlength(w["t"], font=fnt)
        if tw > room and room > 50:
            size = max(24, int(size * room / tw))
            fnt = font(w.get("f", "B"), size)
        y = float(w["y"])
        d.text((x + 3, y + 4), w["t"], font=fnt, fill=(0, 0, 0, int(140 * a)), anchor=anchor)
        d.text((x, y), w["t"], font=fnt, fill=COL.get(w.get("c", "ink"), COL["ink"]) + (int(255 * a),), anchor=anchor)
    out = img.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


def bars(img):
    d = ImageDraw.Draw(img)
    W, H = img.size
    d.rectangle([0, 0, W, 86], fill=(0, 0, 0))
    d.rectangle([0, H - 86, W, H], fill=(0, 0, 0))
    return img


def draw(i):
    fr = S["story"]["frames"][i]
    W, H = S["W"], S["H"]
    if fr.get("bg"):
        img = grade(Image.new("RGB", (W, H), (12, 12, 12)))
    elif fr.get("panes"):
        img = Image.new("RGB", (W, H))
        for p in fr["panes"]:
            part, T = crop(p, tuple(p["wh"]))
            if p.get("sk"):
                part = skeleton(part, kp_of(p["c"], p["f"]), T, p["sk"], glow=p.get("skc", "acc"), width=6)
            img.paste(part, tuple(p["at"]))
        img = grade(img, fr.get("dark", 0))
        if fr.get("line"):
            ImageDraw.Draw(img).rectangle([0, H // 2 - 3, W, H // 2 + 3], fill=COL["acc"])
    else:
        img, T = crop(fr, (W, H))
        img = grade(img, fr.get("dark", 0))
        if fr.get("sk"):
            img = skeleton(img, kp_of(fr["c"], fr["f"]), T, fr["sk"], width=fr.get("skw", 7), glow=fr.get("skc", "acc"))
        if fr.get("arc"):
            k = kp_of(fr["c"], fr["f"])
            if k:
                img = arc(img, k, T, fr["arc"])
    img = words(img, fr.get("w"))
    img = bars(img)
    if "fade" in fr:
        img = Image.blend(Image.new("RGB", (W, H)), img, float(fr["fade"]))
    return img.tobytes()


def extract(clip_path, frames, out_dir):
    """the clip's frames from the first to the last one used, as JPEGs named by frame number"""
    os.makedirs(out_dir, exist_ok=True)
    lo, hi = min(frames), max(frames)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", clip_path, "-vf", f"select='between(n\\,{lo}\\,{hi})'", "-vsync", "0",
                    "-start_number", str(lo), "-q:v", "2", os.path.join(out_dir, "%05d.jpg")], check=True)


def render(story_path, out_path, clip_paths, music=None, workers=None, music_start=0.0):
    story = json.load(open(story_path))
    W, H, fps = story["out"]["W"], story["out"]["H"], story["out"]["fps"]
    tmp = tempfile.mkdtemp(prefix="recap-")
    try:
        dirs = []
        for c, path in enumerate(clip_paths):
            d = os.path.join(tmp, f"c{c}")
            if story["clips"][c]["frames"]:
                extract(path, story["clips"][c]["frames"], d)
            dirs.append(d)
        silent = os.path.join(tmp, "video.mp4")
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                                "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", silent], stdin=subprocess.PIPE)
        n = len(story["frames"])
        with Pool(workers or max(1, os.cpu_count() or 1), initializer=init, initargs=(story_path, dirs, (W, H))) as pool:
            for buf in pool.imap(draw, range(n), chunksize=6):
                enc.stdin.write(buf)
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError("encode failed")
        dur = n / fps
        if music and os.path.exists(music):
            fo = max(0.0, dur - 2.5)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", silent, "-i", music, "-filter_complex",
                            f"[1:a]atrim={music_start}:{music_start + dur},asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.4,afade=t=out:st={fo}:d=2.5,aresample=48000[a]",
                            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out_path], check=True)
        else:
            shutil.move(silent, out_path)
        return {"frames": n, "seconds": round(dur, 1)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    music = None
    if "--music" in args:
        k = args.index("--music"); music = args[k + 1]; del args[k:k + 2]
    print(render(args[0], args[1], args[2:], music=music))
