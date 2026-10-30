"""Image helpers: rectified text-line crops and augmentations. Pillow + NumPy only."""

from __future__ import annotations

import random

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


def _dist(a, b) -> float:
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def crop_quad(image: Image.Image, points: list[list[float]]) -> Image.Image:
    """Cut a (possibly rotated or skewed) text line out as an upright rectangle."""
    tl, tr, br, bl = points
    width = max(1, round(max(_dist(tl, tr), _dist(bl, br))))
    height = max(1, round(max(_dist(tl, bl), _dist(tr, br))))
    # PIL QUAD maps the output rectangle onto the source quad (ul, ll, lr, ur)
    quad = (*tl, *bl, *br, *tr)
    crop = image.convert('RGB').transform((width, height), Image.QUAD, quad, Image.BICUBIC)
    # Text lines are wider than tall; a taller crop is a vertical annotation
    return crop.rotate(90, expand=True) if height > width * 1.5 else crop


def augment(image: Image.Image, rng: random.Random) -> Image.Image:
    """Photo-like degradations: blur, noise, uneven light, low resolution, slight skew."""
    img = image.convert('RGB')
    if rng.random() < 0.5:
        img = img.rotate(rng.uniform(-3, 3), expand=True, fillcolor=(255, 255, 255), resample=Image.BICUBIC)
    if rng.random() < 0.4:
        scale = rng.uniform(0.35, 0.8)
        small = img.resize((max(8, int(img.width * scale)), max(8, int(img.height * scale))), Image.BILINEAR)
        img = small.resize(img.size, Image.BILINEAR)
    if rng.random() < 0.4:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.4)))
    if rng.random() < 0.6:
        img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.55, 1.35))
        img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.6, 1.3))
    arr = np.asarray(img).astype(np.float32)
    if rng.random() < 0.5:  # shadow / glare gradient across the line
        grad = np.linspace(rng.uniform(0.6, 1.0), rng.uniform(0.9, 1.25), arr.shape[1])[None, :, None]
        arr = arr * grad
    if rng.random() < 0.5:
        np_rng = np.random.default_rng(rng.randrange(2**32))
        arr = arr + np_rng.normal(0, rng.uniform(3, 14), arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
