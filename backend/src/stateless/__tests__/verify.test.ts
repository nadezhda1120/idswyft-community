import { describe, it, expect } from 'vitest';
import { runStatelessVerification, inferFlow, missingUploads, wipe } from '../verify.js';
import { front, mockDeps } from './fixtures.js';

const img = () => Buffer.from('image-bytes');

describe('runStatelessVerification', () => {
  it('runs the full flow through every gate and verifies', async () => {
    const deps = mockDeps();
    const result = await runStatelessVerification(
      { front: img(), back: img(), live: img(), documentType: 'auto', flow: 'full' }, deps,
    );
    expect(result).toMatchObject({ final_result: 'verified', status: 'COMPLETE', flow: 'full', rejection: null });
    expect(result.document.front).toMatchObject({ full_name: 'JOHN DOE', id_number: 'AB1234567' });
    expect(result.checks.cross_validation?.verdict).toBe('PASS');
    expect(result.checks.face_match?.passed).toBe(true);
  });

  it('never returns face embeddings, and raw text only on request', async () => {
    const plain = await runStatelessVerification(
      { front: img(), back: img(), live: img(), documentType: 'auto', flow: 'full' }, mockDeps(),
    );
    const json = JSON.stringify(plain);
    expect(json).not.toContain('face_embedding');
    expect(json).not.toContain('raw_text');
    expect(json).not.toContain('raw_barcode_data');

    const withText = await runStatelessVerification(
      { front: img(), back: img(), documentType: 'auto', flow: 'document_only', includeRawText: true }, mockDeps(),
    );
    expect(withText.document.front?.raw_text).toBe('JOHN DOE AB1234567');
    expect(JSON.stringify(withText)).not.toContain('face_embedding');
  });

  it('document_only completes after cross-validation without a live capture', async () => {
    const deps = mockDeps();
    const result = await runStatelessVerification(
      { front: img(), back: img(), documentType: 'auto', flow: 'document_only' }, deps,
    );
    expect(result.final_result).toBe('verified');
    expect(deps.extractLive).not.toHaveBeenCalled();
  });

  it('skips the back side for a passport in the full flow', async () => {
    const deps = mockDeps({
      extractFront: async () => ({ ...structuredClone(front), ocr: { ...front.ocr, detected_document_type: 'passport' } }),
    });
    const result = await runStatelessVerification(
      { front: img(), back: img(), live: img(), documentType: 'passport', flow: 'full' }, deps,
    );
    expect(result.status).toBe('COMPLETE');
    expect(deps.extractBack).not.toHaveBeenCalled();
    expect(deps.extractLive).toHaveBeenCalledOnce();
  });

  it('stops at a failed gate and does not process later uploads', async () => {
    const deps = mockDeps({
      extractFront: async () => ({ ...structuredClone(front), ocr: { full_name: '', date_of_birth: '', id_number: '', expiry_date: '' } }),
    });
    const result = await runStatelessVerification(
      { front: img(), back: img(), live: img(), documentType: 'auto', flow: 'full' }, deps,
    );
    expect(result.final_result).toBe('failed');
    expect(result.rejection).toMatchObject({ reason: 'FRONT_OCR_FAILED' });
    expect(result.rejection?.user_message).toMatch(/retake/i);
    expect(deps.extractBack).not.toHaveBeenCalled();
    expect(deps.extractLive).not.toHaveBeenCalled();
  });

  it('passes the issuing country and document type to the engine', async () => {
    const deps = mockDeps();
    await runStatelessVerification(
      { front: img(), back: img(), documentType: 'national_id', issuingCountry: 'BG', flow: 'document_only' }, deps,
    );
    expect(deps.extractFront).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({
      documentType: 'national_id', issuingCountry: 'BG',
    }));
  });
});

describe('flow selection', () => {
  it('infers the flow from the uploads', () => {
    expect(inferFlow({ back: true, live: true })).toBe('full');
    expect(inferFlow({ back: true, live: false })).toBe('document_only');
    expect(inferFlow({ back: false, live: true })).toBe('identity');
  });

  it('lists uploads a flow needs', () => {
    expect(missingUploads('full', { front: true, back: false, live: true })).toEqual(['back']);
    expect(missingUploads('identity', { front: false, back: false, live: false })).toEqual(['front', 'live']);
    expect(missingUploads('document_only', { front: true, back: true, live: false })).toEqual([]);
  });
});

describe('wipe', () => {
  it('zero-fills buffers and ignores missing ones', () => {
    const a = Buffer.from('secret');
    wipe(a, undefined);
    expect([...a].every(b => b === 0)).toBe(true);
  });
});
