"""ONNX text-line recognizer that reproduces the engine's PaddleOCR recognition
(ppu-paddle-ocr 4.x, core/base-recognition.service.js) exactly, so offline scores
match what the engine reads:

- resize the crop to height 48, width = round(48 * aspect), at least 8 px
- take the red channel as gray, normalise (v / 255 - 0.5) / 0.5, copy to 3 channels
- CTC greedy decode: drop blank (index 0) and repeats; confidence = mean max prob
- dictionary in ppu format: lines of the file, index 0 is the blank (empty line)
"""

from __future__ import annotations

import numpy as np
from PIL import Image

IMAGE_HEIGHT = 48
MIN_CROP_WIDTH = 8


def load_ppu_dictionary(path: str) -> list[str]:
    with open(path, encoding='utf-8') as f:
        return f.read().split('\n')


class OnnxRecognizer:
    def __init__(self, model_path: str, dict_path: str, threads: int = 0):
        import onnxruntime as ort
        options = ort.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(model_path, options, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        self.dictionary = load_ppu_dictionary(dict_path)

    @staticmethod
    def preprocess(image: Image.Image) -> np.ndarray:
        img = image.convert('RGB')
        w, h = img.size
        width = max(MIN_CROP_WIDTH, round(IMAGE_HEIGHT * w / h))
        # The engine resizes on a canvas (bilinear); Pillow's bilinear is the closest match
        red = np.asarray(img.resize((width, IMAGE_HEIGHT), Image.BILINEAR))[:, :, 0].astype(np.float32)
        norm = (red / 255.0 - 0.5) / 0.5
        return np.broadcast_to(norm, (3, IMAGE_HEIGHT, width))[None].copy()

    def decode(self, logits: np.ndarray) -> tuple[str, float]:
        best = logits.argmax(axis=1)
        probs = logits.max(axis=1)
        text, confs, last = [], [], -1
        for t, idx in enumerate(best):
            if idx == 0 or idx == last:
                last = int(idx)
                continue
            if idx < len(self.dictionary):
                text.append(self.dictionary[idx])
                confs.append(float(probs[t]))
            last = int(idx)
        return ''.join(text), (sum(confs) / len(confs) if confs else 0.0)

    def recognize(self, image: Image.Image) -> tuple[str, float]:
        logits = self.session.run(None, {self.input_name: self.preprocess(image)})[0][0]
        return self.decode(logits)
