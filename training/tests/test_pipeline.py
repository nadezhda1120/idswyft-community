"""Tests for the training tools. Run: cd training && python -m pytest tests"""

import json
import os
import random
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from bgocr import bgtext, synth  # noqa: E402
from bgocr.annotations import AnnotationError, load_annotation  # noqa: E402
from bgocr.imaging import crop_quad  # noqa: E402
from bgocr.manifest import model_manifest, verify_model, write_json  # noqa: E402
from bgocr.metrics import evaluate, levenshtein  # noqa: E402
from bgocr.onnx_rec import OnnxRecognizer  # noqa: E402


def run(script, *args):
    return subprocess.run([sys.executable, '-I', os.path.join(ROOT, script), *args], capture_output=True, text=True, encoding='utf-8')


# ── Bulgarian text ───────────────────────────────────────────────────────────

def test_transliteration_matches_the_engine_rules():
    assert bgtext.transliterate('МАРИЯ') == 'MARIA'
    assert bgtext.transliterate('БЪЛГАРИЯ') == 'BULGARIA'
    assert bgtext.transliterate('ЩЕРЮ') == 'SHTERYU'
    assert bgtext.transliterate_text('ВЕЛИКО ТЪРНОВО') == 'VELIKO TARNOVO'


def test_generated_egn_is_valid_and_encodes_the_birth_date():
    rng = random.Random(1)
    for _ in range(200):
        p = bgtext.person(rng)
        egn = bgtext.egn(p['dob'], p['sex'], rng)
        assert bgtext.egn_valid(egn)
        assert egn[4:6] == f'{p["dob"].day:02d}'
        assert (int(egn[8]) % 2 == 1) == (p['sex'] == 'F')


def test_mrz_lines_are_td1_with_valid_check_digits():
    rng = random.Random(2)
    p = bgtext.person(rng)
    lines = bgtext.mrz_td1(p, '600000000', p['dob'].replace(year=p['dob'].year + 30), bgtext.egn(p['dob'], p['sex'], rng))
    assert [len(line) for line in lines] == [30, 30, 30]
    assert lines[0].startswith('IDBGR600000000') and lines[0][14] == bgtext._cd('600000000')
    assert lines[1][29] == bgtext._cd(lines[0][5:30] + lines[1][0:7] + lines[1][8:15] + lines[1][18:29])


# ── Annotations: lawful sources only ─────────────────────────────────────────

def annotation(tmp_path, **source):
    Image.new('RGB', (100, 50), 'white').save(tmp_path / 'card.png')
    data = {'image': 'card.png', 'source': source, 'document': {'type': 'id_card', 'side': 'front'},
            'fields': [{'name': 'x', 'points': [[0, 0], [50, 0], [50, 20], [0, 20]], 'text': 'ИВАНОВА'}]}
    path = tmp_path / 'card.json'
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return str(path)


def test_rejects_verification_uploads_and_unauthorised_sources(tmp_path):
    with pytest.raises(AnnotationError, match='never training data'):
        load_annotation(annotation(tmp_path, kind='production_upload', authorization='x'))
    with pytest.raises(AnnotationError, match='authorization is required'):
        load_annotation(annotation(tmp_path, kind='consented_collection'))
    assert load_annotation(annotation(tmp_path, kind='consented_collection', authorization='consent-0042')).fields[0].text == 'ИВАНОВА'


# ── Images and metrics ───────────────────────────────────────────────────────

def test_crop_quad_rectifies_a_rotated_line():
    img = Image.new('RGB', (200, 200), 'white')
    crop = crop_quad(img, [[50, 60], [150, 70], [148, 100], [48, 90]])
    assert crop.width > crop.height and 95 <= crop.width <= 105


def test_metrics():
    assert levenshtein('ИВАНОВА', 'ИВАНОВ') == 1
    report = evaluate([{'truth': 'A B', 'predicted': 'AB', 'kind': 'x'}, {'truth': 'CD', 'predicted': 'CE', 'kind': 'y'}])
    assert report['overall'] == {'samples': 2, 'line_accuracy': 0.5, 'cer': 0.25}


def test_ctc_decode_drops_blanks_and_repeats():
    rec = OnnxRecognizer.__new__(OnnxRecognizer)
    rec.dictionary = ['', 'А', 'Б']
    logits = np.array([[0.1, 0.9, 0], [0.1, 0.9, 0], [0.9, 0.1, 0], [0.1, 0.9, 0], [0, 0, 1]], dtype=np.float32)
    assert rec.decode(logits)[0] == 'ААБ'


def test_preprocess_matches_the_engine_shape():
    tensor = OnnxRecognizer.preprocess(Image.new('RGB', (200, 50), (255, 0, 0)))
    assert tensor.shape == (1, 3, 48, 192)
    assert tensor.max() == pytest.approx(1.0)


# ── Manifests and checksums ──────────────────────────────────────────────────

def test_model_manifest_detects_tampering(tmp_path):
    (tmp_path / 'rec.onnx').write_bytes(b'model')
    (tmp_path / 'dict.txt').write_text('\nА\n', encoding='utf-8')
    write_json(str(tmp_path / 'manifest.json'),
               model_manifest(str(tmp_path), 'm', '1', 'cyrillic', {'recognition': 'rec.onnx', 'dictionary': 'dict.txt'}))
    assert verify_model(str(tmp_path)) == []
    (tmp_path / 'rec.onnx').write_bytes(b'changed')
    assert verify_model(str(tmp_path)) == ['recognition: checksum mismatch for rec.onnx']


def test_registry_versions_are_immutable(tmp_path):
    (tmp_path / 'm.onnx').write_bytes(b'x')
    (tmp_path / 'd.txt').write_text('\nА\n', encoding='utf-8')
    args = ['add', '--registry', str(tmp_path / 'reg'), '--name', 'bg', '--version', '1.0.0',
            '--onnx', str(tmp_path / 'm.onnx'), '--dict', str(tmp_path / 'd.txt')]
    assert run('registry.py', *args).returncode == 0
    second = run('registry.py', *args)
    assert second.returncode != 0 and 'immutable' in second.stderr
    assert run('registry.py', 'verify', '--registry', str(tmp_path / 'reg')).returncode == 0


# ── Synthetic data and dataset build ─────────────────────────────────────────

def test_synthetic_output_is_reproducible(tmp_path):
    fonts = synth.available_fonts()[:1]
    a = [run('make_synthetic.py', '--out', str(tmp_path / d), '--lines', '30', '--cards', '4', '--seed', '7', '--font', fonts[0])
         for d in ('a', 'b')]
    assert all(r.returncode == 0 for r in a), a[0].stderr
    ma = json.loads((tmp_path / 'a' / 'manifest.json').read_text(encoding='utf-8'))
    mb = json.loads((tmp_path / 'b' / 'manifest.json').read_text(encoding='utf-8'))
    assert ma['content_sha256'] == mb['content_sha256']


def test_build_dataset_splits_by_document(tmp_path):
    fonts = synth.available_fonts()[:1]
    assert run('make_synthetic.py', '--out', str(tmp_path / 's'), '--cards', '12', '--seed', '3', '--font', fonts[0]).returncode == 0
    r = run('build_dataset.py', '--annotations', str(tmp_path / 's' / 'cards'), '--out', str(tmp_path / 'ds'))
    assert r.returncode == 0, r.stderr
    docs = {}
    for split in ('train', 'val', 'test'):
        for line in (tmp_path / 'ds' / 'rec' / f'{split}.txt').read_text(encoding='utf-8').splitlines():
            doc = line.split('\t')[0].split('/')[-1].rsplit('_', 1)[0]
            docs.setdefault(doc, set()).add(split)
    assert docs and all(len(s) == 1 for s in docs.values())  # no document in two splits
    manifest = json.loads((tmp_path / 'ds' / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['sources'] == {'synthetic': 12} and manifest['documents']['test'] >= 1
    with open(tmp_path / 'ds' / 'doc_types.csv', encoding='utf-8') as f:
        assert f.readline().strip() == 'image,country,type,generation,side,split'
