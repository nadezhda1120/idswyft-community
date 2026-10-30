"""Recognition metrics: exact-line accuracy and character error rate, overall and
per field kind (names, dates, numbers, MRZ ...). Deterministic."""

from __future__ import annotations

from collections import defaultdict


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def normalize(text: str) -> str:
    """Compare as the extractors do: whitespace-insensitive (the engine joins boxes with spaces)."""
    return ''.join(text.split())


class Scores:
    def __init__(self):
        self.n = 0
        self.exact = 0
        self.edits = 0
        self.chars = 0

    def add(self, truth: str, predicted: str) -> None:
        t, p = normalize(truth), normalize(predicted)
        self.n += 1
        self.exact += t == p
        self.edits += levenshtein(t, p)
        self.chars += max(1, len(t))

    def as_dict(self) -> dict:
        return {
            'samples': self.n,
            'line_accuracy': round(self.exact / self.n, 4) if self.n else None,
            'cer': round(self.edits / self.chars, 4) if self.chars else None,
        }


def evaluate(pairs, kind_of=lambda item: item.get('kind', 'all')) -> dict:
    """pairs: iterable of dicts with 'truth', 'predicted' and optional 'kind'."""
    overall, by_kind = Scores(), defaultdict(Scores)
    for item in pairs:
        overall.add(item['truth'], item['predicted'])
        by_kind[kind_of(item)].add(item['truth'], item['predicted'])
    return {'overall': overall.as_dict(), 'by_kind': {k: v.as_dict() for k, v in sorted(by_kind.items())}}
