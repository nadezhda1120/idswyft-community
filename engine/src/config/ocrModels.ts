/**
 * OCR model configuration.
 *
 * PaddleOCR's recognition model decides which alphabet can be read. The library
 * default is an English/Latin model, which cannot read Cyrillic. This module lets
 * each script use its own recognition model + character dictionary, all
 * replaceable through environment variables without touching the API:
 *
 *   OCR_DET_MODEL               detection model for every script (path or URL)
 *   OCR_REC_MODEL / OCR_REC_DICT
 *                               Latin recognition model + dictionary (default: library's English v5)
 *   OCR_CYRILLIC_REC_MODEL / OCR_CYRILLIC_REC_DICT
 *                               Cyrillic recognition model + dictionary
 *                               (default: bundled PP-OCRv5 cyrillic model, else downloaded)
 *   OCR_CYRILLIC_ENABLED=false  never switch to the Cyrillic model
 *   OCR_DEFAULT_SCRIPT          script used when no issuing country is known (latin | cyrillic)
 *
 * Text detection (see getOcrDetectionOptions):
 *   OCR_DET_MAX_SIDE            longest side the detector sees, px (default 640, the library default;
 *                               960 read fewer fields on the Bulgarian specimen benchmark)
 *   OCR_DET_AUTO_DESKEW         straighten slightly rotated text before recognition (default false;
 *                               card photos are unwarped by preprocessing instead)
 *   OCR_DET_PADDING_V / OCR_DET_PADDING_H
 *                               box padding as a fraction of box height (defaults 0.4 / 0.6)
 *   OCR_DET_MIN_AREA            drop detected boxes smaller than this, px² (default 25)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type OcrScript = 'latin' | 'cyrillic';

export interface OcrModelPaths {
  detection?: string;
  recognition?: string;
  charactersDictionary?: string;
}

/** Countries whose identity documents are printed in Cyrillic. */
const CYRILLIC_COUNTRIES = new Set(['BG', 'RU', 'UA', 'BY', 'RS', 'MK', 'KZ', 'KG', 'MN']);

const MODEL_BASE_URL = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const DICT_BASE_URL = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';

const CYRILLIC_MODEL_FILE = 'cyrillic_PP-OCRv5_mobile_rec_infer.onnx';
const CYRILLIC_DICT_FILE = 'ppocrv5_cyrillic_dict.txt';

// dist/config → engine/models/ocr (Docker: /app/engine/models/ocr)
const BUNDLED_OCR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models', 'ocr');

function bundledOr(file: string, url: string): string {
  const local = path.join(BUNDLED_OCR_DIR, file);
  return fs.existsSync(local) ? local : url;
}

export function cyrillicEnabled(): boolean {
  return process.env.OCR_CYRILLIC_ENABLED !== 'false';
}

/** Script to recognise for a document from this country (ISO alpha-2). */
export function scriptForCountry(country?: string | null): OcrScript {
  if (!country) {
    return process.env.OCR_DEFAULT_SCRIPT === 'cyrillic' && cyrillicEnabled() ? 'cyrillic' : 'latin';
  }
  return CYRILLIC_COUNTRIES.has(country.toUpperCase()) && cyrillicEnabled() ? 'cyrillic' : 'latin';
}

/** Model paths for a script. Undefined entries fall back to the library defaults. */
export function getOcrModelPaths(script: OcrScript): OcrModelPaths {
  const detection = process.env.OCR_DET_MODEL || undefined;

  if (script === 'cyrillic') {
    return {
      detection,
      recognition: process.env.OCR_CYRILLIC_REC_MODEL
        || bundledOr(CYRILLIC_MODEL_FILE, `${MODEL_BASE_URL}/recognition/multi/cyrillic/v5/${CYRILLIC_MODEL_FILE}`),
      charactersDictionary: process.env.OCR_CYRILLIC_REC_DICT
        || bundledOr(CYRILLIC_DICT_FILE, `${DICT_BASE_URL}/recognition/multi/cyrillic/v5/${CYRILLIC_DICT_FILE}`),
    };
  }

  return {
    detection,
    recognition: process.env.OCR_REC_MODEL || undefined,
    charactersDictionary: process.env.OCR_REC_DICT || undefined,
  };
}

/**
 * Signals in a Latin-model read that the document is Bulgarian: the English title,
 * the MRZ issuing state, or the nationality code. Used to re-read with the
 * Cyrillic model when the caller did not pass an issuing country.
 */
export function looksBulgarian(text: string): boolean {
  return /REPUBLIC\s*OF\s*BULGARIA|\bBULGARIA\b|^[IP][A-Z<]BGR|\bBGR\b/im.test(text ?? '');
}

export interface OcrDetectionOptions {
  maxSideLength: number;
  autoDeskew: boolean;
  paddingVertical: number;
  paddingHorizontal: number;
  minimumAreaThreshold: number;
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Detection parameters for PaddleOCR, from the environment (same for every script). */
export function getOcrDetectionOptions(): OcrDetectionOptions {
  return {
    maxSideLength: envNumber('OCR_DET_MAX_SIDE', 640, 320, 4096),
    autoDeskew: process.env.OCR_DET_AUTO_DESKEW === 'true',
    paddingVertical: envNumber('OCR_DET_PADDING_V', 0.4, 0, 2),
    paddingHorizontal: envNumber('OCR_DET_PADDING_H', 0.6, 0, 2),
    minimumAreaThreshold: envNumber('OCR_DET_MIN_AREA', 25, 0, 10000),
  };
}
