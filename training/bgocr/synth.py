"""Synthetic Bulgarian samples: rendered text lines, and simple cards with layout
and field annotations in the format of annotations.py (source.kind = synthetic).

Deterministic for a given seed and font list. All values are fictitious.
"""

from __future__ import annotations

import os
import random
from datetime import date, timedelta

from PIL import Image, ImageDraw, ImageFont

from . import bgtext
from .imaging import augment

DEFAULT_FONTS = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/cour.ttf',
    'C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/verdana.ttf',
]


def available_fonts(paths: list[str] | None = None) -> list[str]:
    fonts = [p for p in (paths or DEFAULT_FONTS) if os.path.exists(p)]
    if not fonts:
        raise RuntimeError('No Cyrillic-capable TrueType font found; pass --font /path/to/font.ttf')
    return fonts


def _background(rng: random.Random, size: tuple[int, int]) -> Image.Image:
    base = tuple(rng.randrange(215, 256) for _ in range(3))
    img = Image.new('RGB', size, base)
    draw = ImageDraw.Draw(img)
    # Guilloche-like security pattern
    for _ in range(rng.randrange(0, 6)):
        color = tuple(max(0, c - rng.randrange(10, 45)) for c in base)
        y = rng.randrange(size[1])
        draw.arc((-size[0] // 2, y - size[1], size[0] * 3 // 2, y + size[1]), 0, 180, fill=color, width=1)
    return img


def render_line(text: str, font_path: str, rng: random.Random, height: int = 48, degrade: bool = True) -> Image.Image:
    font = ImageFont.truetype(font_path, size=rng.randrange(int(height * 0.55), int(height * 0.8)))
    left, top, right, bottom = font.getbbox(text)
    pad_x, pad_y = rng.randrange(2, 12), rng.randrange(3, 10)
    img = _background(rng, (right - left + 2 * pad_x, bottom - top + 2 * pad_y))
    ink = tuple(rng.randrange(0, 70) for _ in range(3))
    ImageDraw.Draw(img).text((pad_x - left, pad_y - top), text, font=font, fill=ink)
    return augment(img, rng) if degrade else img


def text_samples(n: int, seed: int, kinds: tuple[str, ...] = bgtext.KINDS):
    """Yield (kind, text) pairs, kinds in rotation."""
    rng = random.Random(seed)
    for i in range(n):
        kind = kinds[i % len(kinds)]
        yield kind, bgtext.sample_text(rng, kind)


def synthetic_card(seed: int, fonts: list[str], side: str = 'front') -> tuple[Image.Image, dict]:
    """A simple ID-card-like image plus its annotation (layout + fields)."""
    rng = random.Random(seed)
    p = bgtext.person(rng)
    generation = rng.choice(['id_card_2010', 'id_card_2024'])
    number = bgtext.document_number(rng, generation)
    personal = bgtext.egn(p['dob'], p['sex'], rng)
    expiry = date(2026, 1, 1) + timedelta(days=rng.randrange(0, 3650))

    width, height = 1000, 630
    img = _background(rng, (width, height))
    draw = ImageDraw.Draw(img)
    font_path = rng.choice(fonts)
    label_font = ImageFont.truetype(font_path, 18)
    value_font = ImageFont.truetype(font_path, 30)
    fields, layout = [], []

    def put(text: str, xy: tuple[int, int], font, name: str):
        x, y = xy
        l, t, r, b = draw.textbbox((x, y), text, font=font)
        draw.text((x, y), text, font=font, fill=(20, 20, 30))
        fields.append({'name': name, 'points': [[l - 2, t - 2], [r + 2, t - 2], [r + 2, b + 2], [l - 2, b + 2]], 'text': text})

    put('РЕПУБЛИКА БЪЛГАРИЯ', (300, 20), value_font, 'header_cyrillic')
    put('REPUBLIC OF BULGARIA', (300, 60), label_font, 'header_latin')
    layout.append({'label': 'header', 'points': [[290, 10], [800, 10], [800, 90], [290, 90]]})

    if side == 'front':
        draw.rectangle((40, 120, 300, 460), fill=(190, 190, 195))
        layout.append({'label': 'photo', 'points': [[40, 120], [300, 120], [300, 460], [40, 460]]})
        rows = [
            ('Фамилия/Surname', p['surname'], 'surname_cyrillic'),
            (None, bgtext.transliterate(p['surname']), 'surname_latin'),
            ('Име/Name', p['given'], 'given_name_cyrillic'),
            (None, bgtext.transliterate(p['given']), 'given_name_latin'),
            ('Презиме/Father\'s name', p['father'], 'patronymic_cyrillic'),
            ('ЕГН/Personal No', personal, 'personal_number'),
            ('Дата на раждане/Date of birth', bgtext.dmy(p['dob']), 'date_of_birth'),
            ('Валидност/Date of expiry', bgtext.dmy(expiry), 'expiry_date'),
            ('№ на документа/Document number', number, 'document_number'),
        ]
        y = 115
        for label, value, name in rows:
            if label:
                put(label, (330, y), label_font, 'label')
                y += 22
            put(value, (330, y), value_font, name)
            y += 40
        layout.append({'label': 'text_block', 'points': [[320, 110], [980, 110], [980, y], [320, y]]})
    else:
        city = rng.choice(bgtext.CITIES)
        rows = [
            ('Място на раждане/Place of birth', f'{city}/{bgtext.transliterate_text(city)}', 'place_of_birth'),
            # Printed over three lines; each is its own annotated text line
            ('Постоянен адрес/Residence', bgtext.address(rng), 'address'),
            ('Ръст/Height', str(rng.randrange(150, 200)), 'height'),
            ('Цвят на очите/Color of eyes', '/'.join(rng.choice(bgtext.EYE_COLORS)), 'eye_color'),
            ('Дата на издаване/Date of issue', bgtext.dmy(expiry - timedelta(days=3652)), 'issue_date'),
        ]
        address_font = ImageFont.truetype(font_path, 24)
        y = 110
        for label, value, name in rows:
            put(label, (40, y), label_font, 'label')
            if isinstance(value, list):
                for i, line in enumerate(value):
                    put(line, (40, y + 22 + i * 32), address_font, f'{name}_line{i + 1}')
                y += 22 + 32 * len(value) + 8
            else:
                put(value, (40, y + 22), value_font, name)
                y += 62
        layout.append({'label': 'text_block', 'points': [[30, 100], [980, 100], [980, y], [30, y]]})
        mono = ImageFont.truetype(next((f for f in fonts if 'ono' in f or 'cour' in f or 'consola' in f), font_path), 30)
        my = height - 125
        for i, line in enumerate(bgtext.mrz_td1(p, number, expiry, personal)):
            put(line, (40, my + i * 38), mono, f'mrz_line{i + 1}')
        layout.append({'label': 'mrz', 'points': [[30, my - 6], [980, my - 6], [980, height - 6], [30, height - 6]]})

    annotation = {
        'source': {'kind': 'synthetic', 'authorization': 'generated by training/bgocr/synth.py', 'seed': seed},
        'document': {'country': 'BG', 'type': 'id_card', 'generation': generation, 'side': side},
        'layout': layout,
        'fields': fields,
    }
    return img, annotation
