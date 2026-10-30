"""Fine-tune a PaddleOCR recognition (or detection) model, reproducibly.

    python train.py --config configs/rec_bg_cyrillic_ppocrv5_mobile.yml \
        --paddleocr ../PaddleOCR --train data/datasets/bg-v1/rec/train.txt \
        --val data/datasets/bg-v1/rec/val.txt --run runs/bg-v1-001 [-o Key=Value ...]

Needs the training environment (requirements-train.txt and a PaddleOCR checkout at
the tag in the config); the engine never does. Writes runs/<id>/run.json with the
config and dataset checksums, the PaddleOCR commit and the Paddle version, so a run
can be repeated exactly. Checkpoints land in runs/<id>/checkpoints/.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import yaml  # noqa: E402

from bgocr.manifest import now, sha256_file, sha256_text, write_json  # noqa: E402
from bgocr.onnx_rec import load_ppu_dictionary  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def git(repo: str, *args: str) -> str:
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True).stdout.strip()


def ppu_to_paddle_dictionary(ppu_path: str, out_path: str) -> int:
    """ppu format = blank line + characters + space class; Paddle wants the characters only
    and adds the space itself (use_space_char)."""
    entries = load_ppu_dictionary(ppu_path)
    chars = entries[1:-1] if entries and entries[-1] == '' else entries[1:]
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(chars) + '\n')
    return len(chars)


def download(url: str, dest: str) -> str:
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + '.part'
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, dest)
    return sha256_file(dest)


def set_path(config: dict, dotted: str, value) -> None:
    """Set config['A']['B'][1]['C'] for 'A.B.1.C'; missing dict keys are created."""
    node = config
    parts = dotted.split('.')
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        key = int(part) if isinstance(node, list) else part
        if last:
            node[key] = value
        else:
            if isinstance(node, dict) and key not in node:
                node[key] = {}
            node = node[key]


def dataset_info(label_file: str) -> dict:
    root = os.path.dirname(os.path.abspath(label_file))
    manifest = os.path.join(os.path.dirname(root), 'manifest.json')
    info = {'labels': os.path.abspath(label_file), 'labels_sha256': sha256_file(label_file)}
    if os.path.exists(manifest):
        with open(manifest, encoding='utf-8') as f:
            info['dataset_sha256'] = json.load(f).get('content_sha256')
    return info


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', required=True)
    ap.add_argument('--paddleocr', required=True, help='PaddleOCR checkout')
    ap.add_argument('--train', required=True, action='append', help='recognition label file (repeatable)')
    ap.add_argument('--val', required=True, action='append')
    ap.add_argument('--run', required=True, help='run folder (must not exist)')
    ap.add_argument('--cache', default=os.path.join(HERE, 'data', 'cache'))
    ap.add_argument('-o', '--override', action='append', default=[], help='extra Key=Value for PaddleOCR')
    args = ap.parse_args()

    with open(args.config, encoding='utf-8') as f:
        config_text = f.read()
    config = yaml.safe_load(config_text)
    if os.path.exists(args.run):
        raise SystemExit(f'{args.run} exists; every run gets a new folder')
    os.makedirs(args.run)

    commit = git(args.paddleocr, 'rev-parse', 'HEAD')
    # One commit can carry several tags; check that the pinned one is among them
    tags = git(args.paddleocr, 'tag', '--points-at', 'HEAD').split()
    tag = config['paddleocr']['ref'] if config['paddleocr']['ref'] in tags else git(args.paddleocr, 'describe', '--tags', '--always')
    if tag != config['paddleocr']['ref']:
        print(f'WARNING: PaddleOCR checkout is {tag}, config pins {config["paddleocr"]["ref"]}', file=sys.stderr)

    weights = os.path.join(args.cache, os.path.basename(config['pretrained']['url']))
    weights_sha = download(config['pretrained']['url'], weights)
    pinned = config['pretrained'].get('sha256')
    if pinned and pinned != weights_sha:
        raise SystemExit(f'pretrained weights checksum {weights_sha} does not match the pinned {pinned}')

    kind = config.get('kind', 'recognition')
    dictionary = base_dict = None
    n_chars = 0
    if kind == 'recognition':
        dictionary = os.path.join(args.run, 'dict_paddle.txt')
        base_dict = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(args.config)), config['baseline_dictionary']))
        n_chars = ppu_to_paddle_dictionary(base_dict, dictionary)

    # PaddleOCR reads label paths relative to data_dir; use '/' as data_dir with absolute paths
    def absolute_labels(files: list[str], name: str) -> str:
        out = os.path.join(args.run, f'{name}_labels.txt')
        with open(out, 'w', encoding='utf-8', newline='\n') as w:
            for path in files:
                base = os.path.dirname(os.path.abspath(path))
                for line in open(path, encoding='utf-8'):
                    parts = line.rstrip('\n').split('\t')
                    if len(parts) >= 2:
                        w.write(f'{os.path.join(base, parts[0])}\t{parts[1]}\n')
        return out

    train_labels, val_labels = absolute_labels(args.train, 'train'), absolute_labels(args.val, 'val')
    overrides = {
        **{k: v for k, v in (config.get('overrides') or {}).items()},
        'Global.seed': config.get('seed', 2026),
        'Global.pretrained_model': os.path.splitext(weights)[0],
        'Global.save_model_dir': os.path.abspath(os.path.join(args.run, 'checkpoints')),
        'Train.dataset.data_dir': '/',
        'Train.dataset.label_file_list': [os.path.abspath(train_labels)],
        'Eval.dataset.data_dir': '/',
        'Eval.dataset.label_file_list': [os.path.abspath(val_labels)],
    }
    if dictionary:
        overrides['Global.character_dict_path'] = os.path.abspath(dictionary)
    for kv in args.override:
        k, _, v = kv.partition('=')
        overrides[k] = yaml.safe_load(v)

    # Resolve the full PaddleOCR config here and keep it with the run
    with open(os.path.join(args.paddleocr, config['paddleocr']['base_config']), encoding='utf-8') as f:
        resolved = yaml.safe_load(f)
    for k, v in overrides.items():
        set_path(resolved, k, v)
    resolved_path = os.path.abspath(os.path.join(args.run, 'paddleocr_config.yml'))
    with open(resolved_path, 'w', encoding='utf-8', newline='\n') as f:
        yaml.safe_dump(resolved, f, allow_unicode=True, sort_keys=False)

    command = [sys.executable, 'tools/train.py', '-c', resolved_path]

    try:
        import paddle
        paddle_version = paddle.__version__
    except ImportError:
        paddle_version = None

    record = {
        'name': config['name'], 'run': os.path.basename(os.path.abspath(args.run)), 'started_at': now(),
        'config': os.path.abspath(args.config), 'config_sha256': sha256_text(config_text),
        'paddleocr': {'commit': commit, 'describe': tag, 'base_config': config['paddleocr']['base_config']},
        'paddle_version': paddle_version,
        'pretrained': {'url': config['pretrained']['url'], 'sha256': weights_sha},
        'kind': kind,
        'dictionary': {'source': base_dict, 'sha256': sha256_file(dictionary), 'characters': n_chars} if dictionary else None,
        'train': [dataset_info(p) for p in args.train], 'val': [dataset_info(p) for p in args.val],
        'overrides': overrides, 'resolved_config': resolved_path,
        'resolved_config_sha256': sha256_file(resolved_path), 'command': command,
    }
    write_json(os.path.join(args.run, 'run.json'), record)

    env = {**os.environ, 'PYTHONHASHSEED': str(config.get('seed', 2026))}
    result = subprocess.run(command, cwd=args.paddleocr, env=env)
    record.update({'finished_at': now(), 'exit_code': result.returncode})
    write_json(os.path.join(args.run, 'run.json'), record)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
