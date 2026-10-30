"""Model registry: versioned model folders with checksums.

    python registry.py add --registry REG --name bg-cyrillic-rec --version baseline \
        --onnx cyrillic_PP-OCRv5_mobile_rec_infer.onnx --dict ppocrv5_cyrillic_dict.txt \
        --note "stock PP-OCRv5 mobile cyrillic"
    python registry.py list   --registry REG
    python registry.py verify --registry REG [--name N --version V]

A version folder is immutable: `add` refuses to overwrite one. The engine loads a
version with OCR_CYRILLIC_REC_VERSION=<name>@<version> and OCR_MODEL_REGISTRY=REG,
verifies the checksums before loading, and rolls back by pointing the variable at
the previous version (or unsetting it for the bundled baseline).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bgocr.manifest import model_manifest, verify_model, write_json  # noqa: E402


FILE_NAMES = {'recognition': 'rec.onnx', 'dictionary': 'dict.txt', 'detection': 'det.onnx'}


def add_version(registry: str, name: str, version: str, files: dict[str, str], script: str | None = 'cyrillic', **extra) -> str:
    """files: role ('recognition', 'dictionary' or 'detection') -> source file."""
    folder = os.path.join(registry, name, version)
    if os.path.exists(folder):
        raise SystemExit(f'{name}@{version} already exists; versions are immutable, use a new version')
    os.makedirs(folder)
    for role, src in files.items():
        shutil.copyfile(src, os.path.join(folder, FILE_NAMES[role]))
    write_json(os.path.join(folder, 'manifest.json'),
               model_manifest(folder, name, version, script, {role: FILE_NAMES[role] for role in files}, **extra))
    return folder


def versions(registry: str):
    for name in sorted(os.listdir(registry)) if os.path.isdir(registry) else []:
        for version in sorted(os.listdir(os.path.join(registry, name))):
            folder = os.path.join(registry, name, version)
            if os.path.exists(os.path.join(folder, 'manifest.json')):
                yield name, version, folder


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    add = sub.add_parser('add')
    add.add_argument('--registry', required=True)
    add.add_argument('--name', required=True)
    add.add_argument('--version', required=True)
    add.add_argument('--onnx', required=True)
    add.add_argument('--dict', help='ppu-format dictionary (index 0 = blank); omit for a detection model')
    add.add_argument('--script', default='cyrillic', choices=['cyrillic', 'latin'])
    add.add_argument('--note', default='')
    add.add_argument('--evaluation', help='evaluate.py JSON report to store in the manifest')
    for name in ('list', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--registry', required=True)
        p.add_argument('--name')
        p.add_argument('--version')
    args = ap.parse_args()

    if args.cmd == 'add':
        extra = {'note': args.note}
        if args.evaluation:
            with open(args.evaluation, encoding='utf-8') as f:
                extra['evaluation'] = json.load(f)
        files = {'recognition': args.onnx, 'dictionary': args.dict} if args.dict else {'detection': args.onnx}
        print(add_version(args.registry, args.name, args.version, files, args.script if args.dict else None, **extra))
        return 0

    status = 0
    for name, version, folder in versions(args.registry):
        if (args.name and name != args.name) or (args.version and version != args.version):
            continue
        with open(os.path.join(folder, 'manifest.json'), encoding='utf-8') as f:
            manifest = json.load(f)
        problems = verify_model(folder) if args.cmd == 'verify' else []
        status |= bool(problems)
        main_file = manifest['files'].get('recognition') or manifest['files'].get('detection')
        acc = ((manifest.get('evaluation') or {}).get('models') or {})
        print(f'{name}@{version}  {manifest.get("kind")}  sha256={main_file["sha256"][:12]}  created={manifest.get("created_at")}  {manifest.get("note", "")}'
              + (f'  PROBLEMS: {"; ".join(problems)}' if problems else ('  ok' if args.cmd == 'verify' else ''))
              + (f'  eval={list(acc)}' if acc else ''))
    return status


if __name__ == '__main__':
    sys.exit(main())
