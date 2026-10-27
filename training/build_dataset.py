"""Build training datasets from annotated documents (see bgocr/annotations.py).

    python build_dataset.py --annotations data/annotated --out data/datasets/bg-v1 [--dict dict.txt]

Writes, split by *document* (a held-out document never contributes crops to training):

    rec/{train,val,test}.txt   PaddleOCR recognition labels: "images/x.png<TAB>text<TAB>field"
    rec/images/                rectified text-line crops
    det/{train,val,test}.txt   PaddleOCR detection labels: "image<TAB>[{transcription, points}]"
    layout/{split}.json        layout regions per image (photo, mrz, text_block, ...)
    doc_types.csv              image, country, type, generation, side, split
    charset_report.json        characters missing from the recognition dictionary
    manifest.json              sources, counts and a checksum of every file

Fails on any annotation without a lawful source (bgocr.annotations.ALLOWED_SOURCES).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

from bgocr.annotations import AnnotationError, find_annotations, load_annotation  # noqa: E402
from bgocr.imaging import crop_quad  # noqa: E402
from bgocr.manifest import dataset_manifest, write_json  # noqa: E402
from bgocr.onnx_rec import load_ppu_dictionary  # noqa: E402

SPLITS = ('train', 'val', 'test')


def split_documents(doc_ids: list[str], seed: int, ratios: tuple[float, float, float]) -> dict[str, str]:
    ids = sorted(doc_ids)
    random.Random(seed).shuffle(ids)
    n = len(ids)
    n_test = max(1, round(n * ratios[2])) if n >= 3 else 0
    n_val = max(1, round(n * ratios[1])) if n >= 3 else 0
    out = {}
    for i, doc in enumerate(ids):
        out[doc] = 'test' if i < n_test else 'val' if i < n_test + n_val else 'train'
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--annotations', nargs='+', required=True, help='folders with annotation JSON files')
    ap.add_argument('--out', required=True)
    ap.add_argument('--dict', help='recognition dictionary (ppu or Paddle format) for the charset check')
    ap.add_argument('--seed', type=int, default=2026)
    ap.add_argument('--ratios', default='0.8,0.1,0.1', help='train,val,test share of documents')
    args = ap.parse_args()

    ratios = tuple(float(x) for x in args.ratios.split(','))
    annotations, errors = [], []
    for folder in args.annotations:
        for path in find_annotations(folder):
            try:
                annotations.append(load_annotation(path))
            except AnnotationError as e:
                errors.append(str(e))
    if errors:
        print('Rejected annotations:\n  ' + '\n  '.join(errors), file=sys.stderr)
        return 1
    if not annotations:
        print('No annotations found', file=sys.stderr)
        return 1

    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    for sub in ('rec/images', 'det/images', 'layout'):
        os.makedirs(os.path.join(args.out, sub), exist_ok=True)

    split_of = split_documents([a.doc_id for a in annotations], args.seed, ratios)
    rec_lines = {s: [] for s in SPLITS}
    det_lines = {s: [] for s in SPLITS}
    layout = {s: [] for s in SPLITS}
    chars = Counter()

    with open(os.path.join(args.out, 'doc_types.csv'), 'w', newline='', encoding='utf-8') as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(['image', 'country', 'type', 'generation', 'side', 'split'])
        for ann in sorted(annotations, key=lambda a: a.doc_id):
            split = split_of[ann.doc_id]
            image = Image.open(ann.image)
            det_name = f'{ann.doc_id}{os.path.splitext(ann.image)[1].lower()}'
            shutil.copyfile(ann.image, os.path.join(args.out, 'det', 'images', det_name))
            writer.writerow([det_name, ann.document.get('country', ''), ann.document['type'],
                             ann.document.get('generation', ''), ann.document['side'], split])

            det_lines[split].append(f'images/{det_name}\t' + json.dumps(
                [{'transcription': f.text, 'points': f.points} for f in ann.fields], ensure_ascii=False))
            layout[split].append({'image': f'det/images/{det_name}', 'width': image.width, 'height': image.height,
                                  'document': ann.document, 'regions': ann.layout})
            for i, f in enumerate(ann.fields):
                crop_name = f'{ann.doc_id}_{i:03d}.png'
                crop_quad(image, f.points).save(os.path.join(args.out, 'rec', 'images', crop_name))
                rec_lines[split].append(f'images/{crop_name}\t{f.text}\t{f.name}')
                chars.update(f.text)

    for split in SPLITS:
        for kind, lines in (('rec', rec_lines), ('det', det_lines)):
            with open(os.path.join(args.out, kind, f'{split}.txt'), 'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(lines[split]) + ('\n' if lines[split] else ''))
        write_json(os.path.join(args.out, 'layout', f'{split}.json'), {'images': layout[split]})

    report = {'characters': len(chars)}
    if args.dict:
        entries = load_ppu_dictionary(args.dict)
        known = set(entries) | {' '}
        missing = {c: n for c, n in chars.most_common() if c not in known}
        report.update({'dictionary': os.path.basename(args.dict), 'missing': missing})
        if missing:
            print(f'WARNING: {len(missing)} characters are not in the dictionary: {"".join(missing)}', file=sys.stderr)
    write_json(os.path.join(args.out, 'charset_report.json'), report)

    files = [os.path.join(dp, f) for dp, _, fs in os.walk(args.out) for f in fs if f != 'manifest.json']
    manifest = dataset_manifest(files, args.out, {
        'seed': args.seed, 'ratios': ratios,
        'documents': {s: sum(1 for v in split_of.values() if v == s) for s in SPLITS},
        'text_lines': {s: len(rec_lines[s]) for s in SPLITS},
        'sources': dict(Counter(a.source['kind'] for a in annotations)),
        'document_types': dict(Counter(f'{a.document["type"]}/{a.document["side"]}' for a in annotations)),
    })
    write_json(os.path.join(args.out, 'manifest.json'), manifest)
    print(json.dumps({k: manifest[k] for k in ('documents', 'text_lines', 'sources', 'content_sha256')}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
