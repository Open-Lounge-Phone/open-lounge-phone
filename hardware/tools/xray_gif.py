"""X-ray scans of one part -> an aligned GIF. Usage: xray_gif.py OUT.gif SCAN... [--box x0 y0 x1 y1]

The part is found in every scan by template matching against the second scan (box = a rectangle
around it in that scan, full-resolution pixels), then each frame is cropped around it.
"""
import sys

import numpy as np
from numpy.fft import irfft2, rfft2
from PIL import Image, ImageOps

args = sys.argv[1:]
box = None
if "--box" in args:
    i = args.index("--box")
    box = tuple(int(v) for v in args[i + 1 : i + 5])
    del args[i : i + 5]
out, scans = args[0], args[1:]
imgs = [Image.open(p).convert("L") for p in scans]
arr = [np.asarray(im, dtype=np.float32) for im in imgs]
ref = arr[min(1, len(arr) - 1)]
x0, y0, x1, y1 = box or (0, 0, ref.shape[1], ref.shape[0])
tpl = ref[y0:y1, x0:x1]
th, tw = tpl.shape


def find(img):
    h, w = tpl.shape
    tz = tpl - tpl.mean()
    num = irfft2(rfft2(img - img.mean()) * np.conj(rfft2(tz, s=img.shape)), s=img.shape)
    num = num[: img.shape[0] - h + 1, : img.shape[1] - w + 1]
    ii = np.cumsum(np.cumsum(np.pad(img.astype(np.float64), ((1, 0), (1, 0))), 0), 1)
    ii2 = np.cumsum(np.cumsum(np.pad(img.astype(np.float64) ** 2, ((1, 0), (1, 0))), 0), 1)

    def b(a):
        return a[h:, w:] - a[:-h, w:] - a[h:, :-w] + a[:-h, :-w]

    var = np.maximum(b(ii2) - b(ii) ** 2 / (h * w), 1e-6)
    c = num / np.sqrt(var * (tz**2).sum())
    return np.unravel_index(np.argmax(c), c.shape)[::-1]


side = int(max(tw, th) * 1.4)
frames = []
for im, a in zip(imgs, arr):
    x, y = find(a)
    cx, cy = x + tw // 2, y + th // 2
    c = im.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    frames.append(ImageOps.autocontrast(c, cutoff=0.5).resize((400, 400), Image.LANCZOS))
seq = frames + frames[-2:0:-1]
seq[0].save(out, save_all=True, append_images=seq[1:], duration=350, loop=0, optimize=True)
