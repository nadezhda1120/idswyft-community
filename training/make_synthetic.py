"""Generate synthetic Bulgarian training data (all values fictitious).

    python make_synthetic.py --out data/synthetic --lines 20000 --cards 200 --seed 2026

    lines/{train,val,test}.txt + lines/images/   rendered text lines with photo-like
                                                 degradations, recognition label format
                                                 ("images/x.png<TAB>text<TAB>kind")
    cards/*.png + cards/*.json                   simple ID-card images with layout and
                                                 field annotations (source.kind = synthetic);
                                                 feed them to build_dataset.py
    manifest.json                                seed, fonts and checksums

The same seed and fonts give byte-identical output.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bgocr import synth  # noqa: E402
from bgocr.manifest import dataset_manifest, sha256_file, write_json  # noqa: E402


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--lines', type=int, default=0)
    ap.add_argument('--cards', type=int, default=0)
    ap.add_argument('--seed', type=int, default=2026)
    ap.add_argument('--font', action='append', help='TrueType font with Cyrillic (repeatable)')
    ap.add_argument('--clean', action='store_true', help='no degradations on text lines')
    ap.add_argument('--ratios', default='0.9,0.05,0.05')
    args = ap.parse_args()

    fonts = synth.available_fonts(args.font)
    if os.path.exists(args.out):
        shutil.rmtree(args.out)

    if args.lines:
        images = os.path.join(args.out, 'lines', 'images')
        os.makedirs(images)
        train, val, _ = (float(x) for x in args.ratios.split(','))
        splits = {'train': [], 'val': [], 'test': []}
        rng = random.Random(args.seed + 1)
        for i, (kind, text) in enumerate(synth.text_samples(args.lines, args.seed)):
            name = f'{i:07d}.png'
            synth.render_line(text, rng.choice(fonts), rng, degrade=not args.clean).save(os.path.join(images, name))
            r = (i * 0.6180339887) % 1  # deterministic interleaved split
            split = 'train' if r < train else 'val' if r < train + val else 'test'
            splits[split].append(f'images/{name}\t{text}\t{kind}')
        for split, lines in splits.items():
            with open(os.path.join(args.out, 'lines', f'{split}.txt'), 'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(lines) + ('\n' if lines else ''))

    if args.cards:
        cards = os.path.join(args.out, 'cards')
        os.makedirs(cards)
        for i in range(args.cards):
            side = 'front' if i % 2 == 0 else 'back'
            image, annotation = synth.synthetic_card(args.seed * 100003 + i, fonts, side)
            name = f'synthetic_{i:05d}'
            image.save(os.path.join(cards, f'{name}.png'))
            write_json(os.path.join(cards, f'{name}.json'), {'image': f'{name}.png', **annotation})

    files = [os.path.join(dp, f) for dp, _, fs in os.walk(args.out) for f in fs]
    write_json(os.path.join(args.out, 'manifest.json'), dataset_manifest(files, args.out, {
        'generator': 'training/make_synthetic.py', 'seed': args.seed, 'lines': args.lines, 'cards': args.cards,
        'degraded': not args.clean, 'fonts': {os.path.basename(f): sha256_file(f) for f in fonts},
    }))
    print(json.dumps({'out': args.out, 'lines': args.lines, 'cards': args.cards, 'fonts': [os.path.basename(f) for f in fonts]}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
