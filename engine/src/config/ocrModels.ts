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
 * Versioned models (training/registry.py writes them; see training/README.md):
 *   OCR_MODEL_REGISTRY          registry folder (default: engine/models/registry)
 *   OCR_CYRILLIC_REC_VERSION / OCR_REC_VERSION
 *                               <name>@<version>, e.g. bg-cyrillic-rec@1.0.0. The manifest's
 *                               SHA-256 checksums are verified before the model loads; a missing
 *                               file or a mismatch stops OCR for that script instead of loading
 *                               an unverified model. Rollback: point at the previous version, or
 *                               unset the variable for the bundled baseline. Takes precedence
 *                               over OCR_*_REC_MODEL / OCR_*_REC_DICT.
 *   OCR_DET_VERSION             <name>@<version> of a text-detection model, same rules;
 *                               takes precedence over OCR_DET_MODEL.
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

import crypto from 'crypto';
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

// ── Versioned models from the registry ─────────────────────────

/** Which recognition model a script uses, for logs, /health and the OCR result. */
export interface OcrModelInfo {
  source: 'registry' | 'env' | 'bundled' | 'library';
  name?: string;
  version?: string;
  sha256?: string;
}

type ModelRole = 'recognition' | 'dictionary' | 'detection';

interface RegistryManifest {
  name: string;
  version: string;
  kind?: 'recognition' | 'detection';
  script?: OcrScript | null;
  files: Partial<Record<ModelRole, { path: string; sha256: string }>>;
}

interface VerifiedModel {
  files: Partial<Record<ModelRole, string>>;
  info: OcrModelInfo;
}

const DEFAULT_REGISTRY = path.resolve(BUNDLED_OCR_DIR, '..', 'registry');

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const verified = new Map<string, VerifiedModel>();

/**
 * Resolve "<name>@<version>" in the registry and verify the checksum of every file
 * the given roles need. Throws on a malformed spec, a missing manifest or file, a
 * checksum mismatch, or a model built for another script — the caller must never
 * fall back to an unverified file.
 */
function resolveVersion(spec: string, roles: readonly ModelRole[], script: OcrScript | null, registry: string): VerifiedModel {
  const key = `${registry}|${spec}|${roles.join(',')}`;
  const cached = verified.get(key);
  if (cached) return cached;

  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/.exec(spec.trim());
  if (!match) throw new Error(`OCR model version "${spec}" must look like name@version`);
  const [, name, version] = match;
  const folder = path.join(registry, name, version);
  const manifestPath = path.join(folder, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`OCR model ${spec}: no manifest at ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RegistryManifest;
  if (script && manifest.script && manifest.script !== script) {
    throw new Error(`OCR model ${spec} is a ${manifest.script} model, not ${script}`);
  }

  const files: VerifiedModel['files'] = {};
  for (const role of roles) {
    const entry = manifest.files?.[role];
    if (!entry) throw new Error(`OCR model ${spec}: manifest has no ${role} file`);
    const file = path.resolve(folder, entry.path);
    if (!file.startsWith(path.resolve(folder) + path.sep)) throw new Error(`OCR model ${spec}: ${role} path leaves the model folder`);
    if (!fs.existsSync(file)) throw new Error(`OCR model ${spec}: missing ${entry.path}`);
    if (sha256File(file) !== entry.sha256) throw new Error(`OCR model ${spec}: checksum mismatch for ${entry.path}`);
    files[role] = file;
  }

  const result: VerifiedModel = {
    files,
    info: { source: 'registry', name, version, sha256: manifest.files[roles[0]]!.sha256 },
  };
  verified.set(key, result);
  return result;
}

const registryDir = () => process.env.OCR_MODEL_REGISTRY || DEFAULT_REGISTRY;

/** A verified recognition model (onnx + dictionary) for a script. */
export function resolveRegistryModel(spec: string, script: OcrScript, registry = registryDir()) {
  const model = resolveVersion(spec, ['recognition', 'dictionary'], script, registry);
  return { recognition: model.files.recognition!, dictionary: model.files.dictionary!, info: model.info };
}

/** A verified text-detection model (OCR_DET_VERSION). */
export function resolveRegistryDetection(spec: string, registry = registryDir()) {
  const model = resolveVersion(spec, ['detection'], null, registry);
  return { detection: model.files.detection!, info: model.info };
}

function detectionModel(): string | undefined {
  const spec = process.env.OCR_DET_VERSION;
  return spec ? resolveRegistryDetection(spec).detection : process.env.OCR_DET_MODEL || undefined;
}

function versionVar(script: OcrScript): string | undefined {
  return (script === 'cyrillic' ? process.env.OCR_CYRILLIC_REC_VERSION : process.env.OCR_REC_VERSION) || undefined;
}

/** The recognition model a script will load (verifies a registry model). */
export function describeOcrModel(script: OcrScript): OcrModelInfo {
  const spec = versionVar(script);
  if (spec) return resolveRegistryModel(spec, script).info;
  const envModel = script === 'cyrillic' ? process.env.OCR_CYRILLIC_REC_MODEL : process.env.OCR_REC_MODEL;
  if (envModel) return { source: 'env' };
  if (script === 'cyrillic' && fs.existsSync(path.join(BUNDLED_OCR_DIR, CYRILLIC_MODEL_FILE))) {
    return { source: 'bundled', name: CYRILLIC_MODEL_FILE.replace(/\.onnx$/, ''), version: 'baseline' };
  }
  return { source: 'library' };
}

/** Model paths for a script. Undefined entries fall back to the library defaults. */
export function getOcrModelPaths(script: OcrScript): OcrModelPaths {
  const detection = detectionModel();

  const spec = versionVar(script);
  if (spec) {
    const model = resolveRegistryModel(spec, script);
    return { detection, recognition: model.recognition, charactersDictionary: model.dictionary };
  }

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
