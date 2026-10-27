"""Export a trained checkpoint to ONNX and add it to the model registry.

    python export.py --run runs/bg-v1-001 --paddleocr ../PaddleOCR \
        --registry models/registry --version 1.0.0 [--checkpoint best_accuracy] \
        [--evaluation reports/bg-v1-test.json]

1. PaddleOCR tools/export_model.py  → runs/<id>/inference/
2. paddle2onnx                      → runs/<id>/model.onnx
3. recognition: dictionary back to ppu format (index 0 = blank, as the engine reads it)
4. registry/<name>/<version>/ with manifest.json: checksums, base model, the run
   record (config + dataset checksums) and the evaluation report if given.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from registry import add_version  # noqa: E402


def paddle_to_ppu_dictionary(paddle_dict: str, out_path: str) -> None:
    with open(paddle_dict, encoding='utf-8') as f:
        chars = [line.rstrip('\n') for line in f if line.rstrip('\n') != '']
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n' + '\n'.join(chars) + '\n')


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', required=True)
    ap.add_argument('--paddleocr', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--version', required=True)
    ap.add_argument('--checkpoint', default='best_accuracy', help='checkpoint name inside runs/<id>/checkpoints')
    ap.add_argument('--evaluation', help='evaluate.py report to store with the model')
    ap.add_argument('--opset', type=int, default=14)
    args = ap.parse_args()

    run = os.path.abspath(args.run)
    with open(os.path.join(run, 'run.json'), encoding='utf-8') as f:
        record = json.load(f)
    if record.get('exit_code') not in (0, None):
        raise SystemExit(f'run {record["run"]} did not finish successfully')

    checkpoints = os.path.join(run, 'checkpoints')
    trained_config = os.path.join(checkpoints, 'config.yml')
    inference = os.path.join(run, 'inference')
    subprocess.run([sys.executable, 'tools/export_model.py', '-c', trained_config, '-o',
                    f'Global.pretrained_model={os.path.join(checkpoints, args.checkpoint)}',
                    f'Global.save_inference_dir={inference}'], cwd=args.paddleocr, check=True)

    model_file = next(iter(glob.glob(os.path.join(inference, 'inference.json')) + glob.glob(os.path.join(inference, 'inference.pdmodel'))), None)
    if not model_file:
        raise SystemExit(f'no inference model in {inference}')
    onnx = os.path.join(run, 'model.onnx')
    subprocess.run(['paddle2onnx', '--model_dir', inference, '--model_filename', os.path.basename(model_file),
                    '--params_filename', 'inference.pdiparams', '--save_file', onnx,
                    '--opset_version', str(args.opset)], check=True)

    if record.get('kind', 'recognition') == 'recognition':
        ppu_dict = os.path.join(run, 'dict.txt')
        paddle_to_ppu_dictionary(os.path.join(run, 'dict_paddle.txt'), ppu_dict)
        files, script = {'recognition': onnx, 'dictionary': ppu_dict}, 'cyrillic'
    else:
        files, script = {'detection': onnx}, None

    extra = {
        'note': f'fine-tuned from {record["pretrained"]["url"].rsplit("/", 1)[-1]} in run {record["run"]}',
        'base_model': record['pretrained'],
        'training': {k: record[k] for k in ('run', 'config', 'config_sha256', 'paddleocr', 'paddle_version',
                                            'dictionary', 'train', 'val', 'overrides', 'resolved_config_sha256',
                                            'started_at', 'finished_at')
                     if k in record},
        'checkpoint': args.checkpoint,
    }
    if args.evaluation:
        with open(args.evaluation, encoding='utf-8') as f:
            extra['evaluation'] = json.load(f)
    print(add_version(args.registry, record['name'], args.version, files, script, **extra))
    return 0


if __name__ == '__main__':
    sys.exit(main())
