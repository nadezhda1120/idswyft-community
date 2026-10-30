# Training environment — never used by the API or the engine.
#
#   docker build -t idswyft-training training/
#   docker run --rm -it -v "$PWD/training:/work" idswyft-training bash
#
# Contains PaddlePaddle (CPU), paddle2onnx and a PaddleOCR checkout pinned to the tag
# in configs/rec_bg_cyrillic_ppocrv5_mobile.yml. Build context is training/ only, so
# no application code or verification data can enter the image.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git fonts-dejavu-core libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ARG PADDLEOCR_REF=v3.7.0
RUN git clone --depth 1 --branch ${PADDLEOCR_REF} https://github.com/PaddlePaddle/PaddleOCR.git /opt/PaddleOCR

COPY requirements.txt requirements-train.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt -r /tmp/requirements-train.txt \
    && pip install --no-cache-dir -r /opt/PaddleOCR/requirements.txt

WORKDIR /work
