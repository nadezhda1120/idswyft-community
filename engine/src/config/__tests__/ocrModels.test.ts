import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRegistryModel, resolveRegistryDetection, getOcrModelPaths, describeOcrModel } from '../ocrModels.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let registry: string;
let n = 0;

/** A registry version folder like training/registry.py writes. */
function addVersion(name: string, version: string, opts: { script?: string; tamper?: boolean } = {}) {
  const folder = path.join(registry, name, version);
  fs.mkdirSync(folder, { recursive: true });
  const model = `onnx-${name}-${version}`;
  fs.writeFileSync(path.join(folder, 'rec.onnx'), model);
  fs.writeFileSync(path.join(folder, 'dict.txt'), '\na\nb\n');
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    name, version, script: opts.script ?? 'cyrillic',
    files: {
      recognition: { path: 'rec.onnx', sha256: opts.tamper ? sha('something else') : sha(model) },
      dictionary: { path: 'dict.txt', sha256: sha('\na\nb\n') },
    },
  }));
  return folder;
}

beforeEach(() => {
  registry = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-registry-${n++}-`));
  process.env.OCR_MODEL_REGISTRY = registry;
});

afterEach(() => {
  delete process.env.OCR_MODEL_REGISTRY;
  delete process.env.OCR_CYRILLIC_REC_VERSION;
  delete process.env.OCR_CYRILLIC_REC_MODEL;
  delete process.env.OCR_DET_VERSION;
  fs.rmSync(registry, { recursive: true, force: true });
});

describe('OCR model registry', () => {
  it('loads a verified version and reports it', () => {
    const folder = addVersion('bg-cyrillic-rec', '1.0.0');
    process.env.OCR_CYRILLIC_REC_VERSION = 'bg-cyrillic-rec@1.0.0';
    const paths = getOcrModelPaths('cyrillic');
    expect(paths.recognition).toBe(path.join(folder, 'rec.onnx'));
    expect(paths.charactersDictionary).toBe(path.join(folder, 'dict.txt'));
    expect(describeOcrModel('cyrillic')).toEqual({
      source: 'registry', name: 'bg-cyrillic-rec', version: '1.0.0', sha256: sha('onnx-bg-cyrillic-rec-1.0.0'),
    });
  });

  it('takes precedence over OCR_CYRILLIC_REC_MODEL', () => {
    addVersion('bg-cyrillic-rec', '1.0.0');
    process.env.OCR_CYRILLIC_REC_MODEL = '/elsewhere/model.onnx';
    process.env.OCR_CYRILLIC_REC_VERSION = 'bg-cyrillic-rec@1.0.0';
    expect(getOcrModelPaths('cyrillic').recognition).toContain(path.join('bg-cyrillic-rec', '1.0.0'));
  });

  it('refuses a model whose checksum does not match', () => {
    addVersion('bg-cyrillic-rec', '2.0.0', { tamper: true });
    expect(() => resolveRegistryModel('bg-cyrillic-rec@2.0.0', 'cyrillic', registry)).toThrow(/checksum mismatch/);
  });

  it('refuses a missing version, a malformed spec and a model for another script', () => {
    addVersion('latin-rec', '1.0.0', { script: 'latin' });
    expect(() => resolveRegistryModel('bg-cyrillic-rec@9.9.9', 'cyrillic', registry)).toThrow(/no manifest/);
    expect(() => resolveRegistryModel('../../etc@1', 'cyrillic', registry)).toThrow(/name@version/);
    expect(() => resolveRegistryModel('latin-rec@1.0.0', 'cyrillic', registry)).toThrow(/latin model/);
  });

  it('loads a verified detection model for every script', () => {
    const folder = path.join(registry, 'bg-text-det', '1.0.0');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'det.onnx'), 'det');
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
      name: 'bg-text-det', version: '1.0.0', kind: 'detection', script: null,
      files: { detection: { path: 'det.onnx', sha256: sha('det') } },
    }));
    process.env.OCR_DET_VERSION = 'bg-text-det@1.0.0';
    expect(getOcrModelPaths('latin').detection).toBe(path.join(folder, 'det.onnx'));
    expect(getOcrModelPaths('cyrillic').detection).toBe(path.join(folder, 'det.onnx'));
    fs.writeFileSync(path.join(folder, 'det.onnx'), 'swapped');
    expect(() => resolveRegistryDetection('bg-text-det@1.0.0', registry + path.sep)).toThrow(/checksum mismatch/);
  });

  it('rolls back by switching or unsetting the version', () => {
    addVersion('bg-cyrillic-rec', '1.0.0');
    addVersion('bg-cyrillic-rec', '1.1.0');
    process.env.OCR_CYRILLIC_REC_VERSION = 'bg-cyrillic-rec@1.1.0';
    expect(describeOcrModel('cyrillic').version).toBe('1.1.0');
    process.env.OCR_CYRILLIC_REC_VERSION = 'bg-cyrillic-rec@1.0.0';
    expect(describeOcrModel('cyrillic').version).toBe('1.0.0');
    delete process.env.OCR_CYRILLIC_REC_VERSION;
    expect(describeOcrModel('cyrillic').source).not.toBe('registry');
  });
});
