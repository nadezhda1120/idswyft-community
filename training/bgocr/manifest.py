"""Checksums and manifests for datasets, training runs and exported models.

A model version lives in its own folder:

    <registry>/<name>/<version>/
        manifest.json          # this module writes it; the engine verifies it
        rec.onnx
        dict.txt               # ppu format (index 0 = blank)

manifest.json:
{
  "name": "bg-cyrillic-rec", "version": "1.0.0", "kind": "recognition", "script": "cyrillic",
  "files": {"recognition": {"path": "rec.onnx", "sha256": "..."},
            "dictionary":  {"path": "dict.txt", "sha256": "..."}},
  "base_model": {...}, "training": {...}, "evaluation": {...}, "created_at": "..."
}
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def dataset_manifest(files: list[str], root: str, extra: dict) -> dict:
    """Hash every file of a built dataset so a training run records exactly what it saw."""
    entries = {os.path.relpath(p, root).replace(os.sep, '/'): sha256_file(p) for p in sorted(files)}
    return {**extra, 'created_at': now(), 'files': len(entries),
            'content_sha256': sha256_text(json.dumps(entries, sort_keys=True)), 'checksums': entries}


def model_manifest(folder: str, name: str, version: str, script: str, files: dict[str, str], **extra) -> dict:
    """files: role -> file name inside `folder`."""
    return {
        'name': name, 'version': version, 'kind': 'detection' if 'detection' in files else 'recognition', 'script': script,
        'files': {role: {'path': f, 'sha256': sha256_file(os.path.join(folder, f))} for role, f in files.items()},
        **extra, 'created_at': now(),
    }


def verify_model(folder: str) -> list[str]:
    """Problems with a model folder (empty list = all files present and matching)."""
    with open(os.path.join(folder, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    problems = []
    for role, entry in manifest.get('files', {}).items():
        path = os.path.join(folder, entry['path'])
        if not os.path.exists(path):
            problems.append(f'{role}: missing {entry["path"]}')
        elif sha256_file(path) != entry['sha256']:
            problems.append(f'{role}: checksum mismatch for {entry["path"]}')
    return problems
