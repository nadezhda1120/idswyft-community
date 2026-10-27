"""Evaluate recognition models on held-out text lines and compare them.

    python evaluate.py --labels data/datasets/bg-v1/rec/test.txt \
        --model baseline=models/registry/bg-cyrillic-rec/baseline \
        --model candidate=models/registry/bg-cyrillic-rec/1.0.0 \
        --report reports/bg-v1-test.json

--model NAME=FOLDER     a registry folder (manifest.json is verified first), or
--model NAME=ONNX,DICT  a model file and its ppu-format dictionary.
The first model is the baseline; the others are reported with deltas against it.

Labels: "image<TAB>text[<TAB>kind]" lines, image paths relative to the label file.
Recognition runs exactly as in the engine (bgocr/onnx_rec.py), so these numbers are
what the engine would read from the same crops.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

from bgocr.manifest import now, sha256_file, verify_model, write_json  # noqa: E402
from bgocr.metrics import evaluate  # noqa: E402
from bgocr.onnx_rec import OnnxRecognizer  # noqa: E402


def resolve_model(spec: str) -> tuple[str, str, str, dict]:
    name, _, target = spec.partition('=')
    if not target:
        raise SystemExit(f'--model needs NAME=FOLDER or NAME=ONNX,DICT (got {spec})')
    if ',' in target:
        onnx, dictionary = target.split(',', 1)
        return name, onnx, dictionary, {}
    problems = verify_model(target)
    if problems:
        raise SystemExit(f'{name}: {"; ".join(problems)}')
    with open(os.path.join(target, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    files = manifest['files']
    return (name, os.path.join(target, files['recognition']['path']),
            os.path.join(target, files['dictionary']['path']),
            {'name': manifest.get('name'), 'version': manifest.get('version')})


def read_labels(path: str, limit: int | None) -> list[dict]:
    base = os.path.dirname(os.path.abspath(path))
    items = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 2:
                continue
            items.append({'image': os.path.join(base, parts[0]), 'truth': parts[1],
                          'kind': parts[2] if len(parts) > 2 else 'all'})
    return items[:limit] if limit else items


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--labels', required=True, action='append', help='label file (repeatable)')
    ap.add_argument('--model', required=True, action='append')
    ap.add_argument('--report', help='write the full JSON report here')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--errors', type=int, default=0, help='print this many misreads per model')
    args = ap.parse_args()

    items = [it for path in args.labels for it in read_labels(path, args.limit)]
    images = {it['image']: Image.open(it['image']).convert('RGB') for it in items}
    report = {'created_at': now(), 'labels': {p: sha256_file(p) for p in args.labels}, 'samples': len(items), 'models': {}}

    for spec in args.model:
        name, onnx, dictionary, meta = resolve_model(spec)
        rec = OnnxRecognizer(onnx, dictionary)
        pairs = []
        for it in items:
            text, conf = rec.recognize(images[it['image']])
            pairs.append({**it, 'predicted': text, 'confidence': conf})
        report['models'][name] = {**meta, 'onnx_sha256': sha256_file(onnx), 'dict_sha256': sha256_file(dictionary),
                                  **evaluate(pairs)}
        if args.errors:
            wrong = [p for p in pairs if ''.join(p['truth'].split()) != ''.join(p['predicted'].split())]
            for p in wrong[:args.errors]:
                print(f'  [{name}] {p["kind"]}: {p["truth"]!r} -> {p["predicted"]!r}')

    names = list(report['models'])
    base = report['models'][names[0]]
    for other in names[1:]:
        m = report['models'][other]
        m['delta_vs_' + names[0]] = {
            'line_accuracy': round(m['overall']['line_accuracy'] - base['overall']['line_accuracy'], 4),
            'cer': round(m['overall']['cer'] - base['overall']['cer'], 4),
        }

    kinds = sorted({k for m in report['models'].values() for k in m['by_kind']})
    print(f'{len(items)} samples')
    print('| kind | ' + ' | '.join(f'{n} acc | {n} CER' for n in names) + ' |')
    print('|---|' + '---|---|' * len(names))
    for kind in ['overall'] + kinds:
        row = [report['models'][n]['overall'] if kind == 'overall' else report['models'][n]['by_kind'].get(kind, {}) for n in names]
        cells = ' | '.join(f'{r.get("line_accuracy", "-")} | {r.get("cer", "-")}' for r in row)
        print(f'| {kind} | {cells} |')

    if args.report:
        write_json(args.report, report)
    return 0


if __name__ == '__main__':
    sys.exit(main())
