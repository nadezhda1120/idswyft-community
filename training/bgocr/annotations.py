"""Annotation format for training documents, and its validation.

One JSON file per document image (`<image>.json` next to it, or any name with an
`image` field):

{
  "image": "card_0001.jpg",
  "source": {                        # required: where the image legally comes from
    "kind": "synthetic | public_specimen | consented_collection | licensed_dataset",
    "authorization": "consent form id, licence, or URL of the public-domain source",
    "collected_on": "2026-10-01"
  },
  "document": {"country": "BG", "type": "id_card", "generation": "id_card_2024", "side": "front"},
  "layout": [                        # optional: regions of the card
    {"label": "photo | mrz | text_block | signature | header", "points": [[x,y],[x,y],[x,y],[x,y]]}
  ],
  "fields": [                        # text lines with their transcription
    {"name": "surname_cyrillic", "points": [[x,y],[x,y],[x,y],[x,y]], "text": "ИВАНОВА"}
  ]
}

Points are the four corners clockwise from top-left, in image pixels. Images from
verification requests are not an accepted source: `kind` has no such value, and
`production_upload` (or anything unknown) is rejected.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

ALLOWED_SOURCES = {'synthetic', 'public_specimen', 'consented_collection', 'licensed_dataset'}
DOCUMENT_TYPES = {'id_card', 'passport', 'driving_licence'}
SIDES = {'front', 'back', 'data_page'}
LAYOUT_LABELS = {'photo', 'mrz', 'text_block', 'signature', 'header', 'barcode', 'chip'}


@dataclass
class Field:
    name: str
    points: list[list[float]]
    text: str


@dataclass
class Annotation:
    path: str              # the annotation file
    image: str             # absolute image path
    source: dict
    document: dict
    layout: list[dict] = field(default_factory=list)
    fields: list[Field] = field(default_factory=list)

    @property
    def doc_id(self) -> str:
        return os.path.splitext(os.path.basename(self.image))[0]


class AnnotationError(ValueError):
    pass


def _check_points(points, where: str) -> None:
    if (not isinstance(points, list) or len(points) != 4
            or not all(isinstance(p, list) and len(p) == 2 and all(isinstance(c, (int, float)) for c in p) for p in points)):
        raise AnnotationError(f'{where}: points must be 4 [x, y] pairs')


def load_annotation(path: str) -> Annotation:
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    where = os.path.basename(path)

    source = data.get('source') or {}
    if source.get('kind') not in ALLOWED_SOURCES:
        raise AnnotationError(f'{where}: source.kind must be one of {sorted(ALLOWED_SOURCES)} '
                              '(images from verification requests are never training data)')
    if source.get('kind') != 'synthetic' and not str(source.get('authorization') or '').strip():
        raise AnnotationError(f'{where}: source.authorization is required (consent id, licence or public-domain URL)')

    image = data.get('image')
    if not image:
        raise AnnotationError(f'{where}: image is required')
    image_path = image if os.path.isabs(image) else os.path.join(os.path.dirname(path), image)
    if not os.path.exists(image_path):
        raise AnnotationError(f'{where}: image not found: {image}')

    document = data.get('document') or {}
    if document.get('type') not in DOCUMENT_TYPES:
        raise AnnotationError(f'{where}: document.type must be one of {sorted(DOCUMENT_TYPES)}')
    if document.get('side') not in SIDES:
        raise AnnotationError(f'{where}: document.side must be one of {sorted(SIDES)}')

    layout = data.get('layout') or []
    for i, region in enumerate(layout):
        if region.get('label') not in LAYOUT_LABELS:
            raise AnnotationError(f'{where}: layout[{i}].label must be one of {sorted(LAYOUT_LABELS)}')
        _check_points(region.get('points'), f'{where}: layout[{i}]')

    fields = []
    for i, f in enumerate(data.get('fields') or []):
        _check_points(f.get('points'), f'{where}: fields[{i}]')
        text = f.get('text')
        if not isinstance(text, str) or not text.strip():
            raise AnnotationError(f'{where}: fields[{i}].text must be a non-empty transcription')
        fields.append(Field(name=str(f.get('name') or 'text'), points=f['points'], text=text))

    return Annotation(path=path, image=os.path.abspath(image_path), source=source,
                      document=document, layout=layout, fields=fields)


def find_annotations(root: str) -> list[str]:
    out = []
    for dirpath, _, files in os.walk(root):
        out += [os.path.join(dirpath, f) for f in files if f.endswith('.json') and f != 'manifest.json']
    return sorted(out)
