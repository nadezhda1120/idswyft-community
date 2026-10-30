# Training and evaluation for Bulgarian documents

Offline tools to build datasets, measure the OCR models, fine-tune them and hand a
new version to the engine. **Nothing here runs in production**: the engine and the
API never import it, `training/` is excluded from their Docker build context, and
the engine only reads finished model files from a registry folder.

```
make_synthetic.py ─┐
annotated images ──┴─▶ build_dataset.py ─▶ evaluate.py (baseline) ─▶ train.py ─▶ export.py ─▶ registry ─▶ engine
                                                   ▲                                 │
                                                   └──────── evaluate.py (compare) ◀─┘
```

## Data rules

- **Only lawful, authorized data.** Every annotation declares `source.kind`
  (`synthetic`, `public_specimen`, `consented_collection`, `licensed_dataset`) and,
  except for synthetic data, `source.authorization` (consent id, licence or the
  public-domain URL). `build_dataset.py` refuses anything else.
- **Verification uploads are never training data.** There is no code path from the
  API or the engine to these tools, and `production_upload` is not an accepted source.
  Collecting real cards for training needs its own consent, outside Idswyft.
- Datasets, runs, reports and model files stay out of git (`.gitignore`).

## Setup

```bash
cd training
pip install -r requirements.txt          # dataset tools + evaluation (no Paddle)
docker build -t idswyft-training .       # training environment (Paddle, PaddleOCR v3.7.0, paddle2onnx)
python -m pytest tests                   # tool tests
```

## 1. Datasets

**Annotation format** (one JSON per image, see `bgocr/annotations.py`): document type,
generation and side; layout regions (`photo`, `mrz`, `text_block`, ...); and every text
line as a 4-point box with its transcription.

```bash
# Synthetic: rendered text lines (names, dates, ЕГН, numbers, MRZ, labels, addresses,
# bilingual fields) with photo-like degradations, plus annotated synthetic cards
python make_synthetic.py --out data/synthetic --lines 20000 --cards 400 --seed 2026

# Annotated documents (real or synthetic) → recognition crops, detection labels,
# layout regions, document-type labels; split by document, so no held-out card leaks
python build_dataset.py --annotations data/annotated data/synthetic/cards \
    --out data/datasets/bg-v1 --dict models/baseline/ppocrv5_cyrillic_dict.txt
```

`build_dataset.py` output: `rec/{train,val,test}.txt` + crops, `det/{split}.txt`,
`layout/{split}.json`, `doc_types.csv`, `charset_report.json` (characters the model's
dictionary cannot produce) and `manifest.json` (sources and a checksum of every file).

## 2. Baseline first

```bash
python registry.py add --registry models/registry --name bg-cyrillic-rec --version baseline \
    --onnx <engine>/models/ocr/cyrillic_PP-OCRv5_mobile_rec_infer.onnx \
    --dict models/baseline/ppocrv5_cyrillic_dict.txt --note "stock PP-OCRv5 mobile cyrillic"

python evaluate.py --labels data/datasets/bg-v1/rec/test.txt \
    --model baseline=models/registry/bg-cyrillic-rec/baseline --report reports/baseline.json --errors 20
```

`evaluate.py` runs the model exactly as the engine does (`bgocr/onnx_rec.py` mirrors
ppu-paddle-ocr's preprocessing and CTC decoding) and reports line accuracy and character
error rate overall and per field kind. Field-level accuracy on whole cards is measured
against the engine itself (`test-samples/bg-id/tools/compare_expected.py`).

Baseline on 1272 synthetic lines (seed 2026): **line accuracy 0.70, CER 0.065**. Dates,
ЕГН and document numbers 1.00; the errors are Latin/Cyrillic look-alikes in bilingual
lines (`СИНИ/ВLUE`, `ГАБРОВО/ГАВРОВО`, `EГH/Personal No`). Fine-tune only when a
field kind the extractors rely on is below what the verification needs.

## 3. Fine-tune (recognition)

```bash
docker run --rm -v "$PWD:/work" idswyft-training \
  python train.py --config configs/rec_bg_cyrillic_ppocrv5_mobile.yml --paddleocr /opt/PaddleOCR \
    --train data/datasets/bg-v1/rec/train.txt --train data/synthetic/lines/train.txt \
    --val data/datasets/bg-v1/rec/val.txt --run runs/bg-v1-001
```

Starts from the pretrained PP-OCRv5 Cyrillic weights and keeps the baseline dictionary
(same 852 classes), so the result is a drop-in replacement. `runs/<id>/run.json`
records the config checksum, the fully resolved PaddleOCR config, the dataset
checksums, the PaddleOCR commit and the Paddle version; a run folder is never reused.

**Resources.** On CPU, PP-OCRv5 mobile recognition trains at roughly 0.7 lines/s
(measured: 12 cores, batch 4), and batch 24 needed more than 4 GB of RAM; a real
fine-tune (tens of thousands of lines, tens of epochs) needs a GPU: install
`paddlepaddle-gpu` instead of `paddlepaddle` and pass `-o Global.use_gpu=true`.
On a small machine lower `Train.sampler.first_bs`, `Train.loader.batch_size_per_card`
and `Train.loader.num_workers`.

Text detection (layout) is trained the same way with `configs/det_bg_ppocrv5_mobile.yml`
and `det/{split}.txt`, only if the stock detector misses or merges fields on real cards.
Face recognition and liveness models are not retrained here.

## 4. Export, compare, register

```bash
docker run --rm -v "$PWD:/work" idswyft-training \
  python export.py --run runs/bg-v1-001 --paddleocr /opt/PaddleOCR --registry models/registry --version 1.0.0

python evaluate.py --labels data/datasets/bg-v1/rec/test.txt \
    --model baseline=models/registry/bg-cyrillic-rec/baseline \
    --model candidate=models/registry/bg-cyrillic-rec/1.0.0 --report reports/1.0.0-vs-baseline.json

python registry.py verify --registry models/registry
```

A version folder holds `rec.onnx`, `dict.txt` and `manifest.json` with SHA-256
checksums, the base model, the training record and (optionally) the evaluation report.
Versions are immutable.

## 5. Use in the engine, roll back

| Variable | Meaning |
|---|---|
| `OCR_MODEL_REGISTRY` | registry folder (default `engine/models/registry`; `docker-compose.ocr.yml` mounts `training/models/registry` there read-only) |
| `OCR_CYRILLIC_REC_VERSION` | e.g. `bg-cyrillic-rec@1.0.0` |
| `OCR_DET_VERSION` | e.g. `bg-text-det@1.0.0` |

The engine verifies the checksums before loading and refuses a missing file or a
mismatch (OCR for that script fails instead of running an unverified model). `/health`
and every OCR result (`ocr_model`) say which version read the document.

**Rollback**: set the variable to the previous version, or remove it to go back to the
bundled baseline, and restart the engine. No rebuild needed.
