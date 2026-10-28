import { describe, it, expect } from 'vitest';
import { evaluateGate2 } from '../gates/gate2-backDocument.js';
import type { BackExtractionResult, FrontExtractionResult } from '@idswyft/shared';

function makeBackResult(overrides: Partial<BackExtractionResult> = {}): BackExtractionResult {
  return {
    qr_payload: {
      first_name: 'JOHN',
      last_name: 'DOE',
      date_of_birth: '1990-01-15',
      id_number: 'AB1234567',
      expiry_date: '2030-12-31',
    },
    mrz_result: null,
    barcode_format: 'PDF417',
    raw_barcode_data: '@\n\x1e\rANSI636000090002...',
    ...overrides,
  };
}

function makeFrontResult(): FrontExtractionResult {
  return {
    ocr: {
      full_name: 'JOHN DOE',
      date_of_birth: '1990-01-15',
      id_number: 'AB1234567',
      expiry_date: '2030-12-31',
    },
    face_embedding: [0.1, 0.2],
    face_confidence: 0.92,
    ocr_confidence: 0.87,
    mrz_from_front: null,
  };
}

describe('Gate 2 — Back Document Integrity', () => {
  // ─── US Documents (default, no issuingCountry) ────────────────

  it('PASSES when barcode decoded and no MRZ issues', () => {
    const result = evaluateGate2(makeBackResult(), makeFrontResult());
    expect(result.passed).toBe(true);
    expect(result.rejection_reason).toBeNull();
  });

  it('FAILS with BACK_BARCODE_NOT_FOUND when qr_payload is null (US)', () => {
    const result = evaluateGate2(makeBackResult({ qr_payload: null, barcode_format: null }), makeFrontResult());
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_BARCODE_NOT_FOUND');
  });

  it('FAILS with BACK_BARCODE_NOT_FOUND for explicit US without barcode', () => {
    const result = evaluateGate2(
      makeBackResult({ qr_payload: null, barcode_format: null }),
      makeFrontResult(),
      'US',
    );
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_BARCODE_NOT_FOUND');
  });

  it('PASSES when MRZ checksums are valid', () => {
    const back = makeBackResult({
      mrz_result: {
        raw_lines: ['P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'AB12345671USA9001150M3012310<<<<<<<<<<<<<<00'],
        checksums_valid: true,
      },
    });
    const result = evaluateGate2(back, makeFrontResult());
    expect(result.passed).toBe(true);
  });

  it('FAILS with BACK_MRZ_UNREADABLE (retake) when checksums fail and no field contradicts the front', () => {
    const back = makeBackResult({
      mrz_result: {
        raw_lines: ['P<USADOE<<JOHN...', 'AB12345679USA9001150M3012310...'],
        checksums_valid: false,
      },
    });
    const result = evaluateGate2(back, makeFrontResult());
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_MRZ_UNREADABLE');
    expect(result.user_message).toMatch(/retake/i);
  });

  it('FAILS with BACK_MRZ_BARCODE_MISMATCH when front MRZ and back MRZ disagree', () => {
    const front = makeFrontResult();
    front.mrz_from_front = ['P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'AB12345671USA9001150M3012310<<<<<<<<<<<<<<00'];

    const back = makeBackResult({
      mrz_result: {
        raw_lines: ['P<USASMITH<<JANE<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'XY98765431USA8501150F2812310<<<<<<<<<<<<<<00'],
        checksums_valid: true,
        fields: { name: 'SMITH JANE', id_number: 'XY9876543' },
      },
    });

    const result = evaluateGate2(back, front);
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_MRZ_BARCODE_MISMATCH');
  });

  it('PASSES when front has no MRZ (cannot mismatch)', () => {
    const front = makeFrontResult();
    front.mrz_from_front = null;

    const back = makeBackResult({
      mrz_result: {
        raw_lines: ['P<USADOE<<JOHN...'],
        checksums_valid: true,
      },
    });

    const result = evaluateGate2(back, front);
    expect(result.passed).toBe(true);
  });

  it('provides user_message on failure', () => {
    const result = evaluateGate2(makeBackResult({ qr_payload: null, barcode_format: null }), makeFrontResult());
    expect(result.user_message).toBeTruthy();
  });

  // ─── International Documents (non-US) ────────────────────────

  it('PASSES for non-US document with MRZ only (no barcode)', () => {
    const back = makeBackResult({
      qr_payload: null,
      barcode_format: 'MRZ_TD1',
      raw_barcode_data: null,
      mrz_result: {
        raw_lines: [
          'IDGBRDOE<<JOHN<<<<<<<<<<<<<<<',
          '1234567890GBR9001150M3012318',
          '<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
        ],
        checksums_valid: true,
      },
    });

    const result = evaluateGate2(back, makeFrontResult(), 'GB');
    expect(result.passed).toBe(true);
  });

  it('PASSES for non-US document with MRZ-populated qr_payload', () => {
    const back = makeBackResult({
      qr_payload: {
        first_name: 'JOHN',
        last_name: 'DOE',
        date_of_birth: '1990-01-15',
        id_number: '1234567890',
        expiry_date: '2030-12-31',
        nationality: 'GBR',
      },
      barcode_format: 'MRZ_TD3',
      raw_barcode_data: null,
      mrz_result: {
        raw_lines: [
          'P<GBRDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
          '12345678901GBR9001150M3012310<<<<<<<<<<<<<<0',
        ],
        checksums_valid: true,
      },
    });

    const result = evaluateGate2(back, makeFrontResult(), 'GB');
    expect(result.passed).toBe(true);
  });

  it('FAILS for non-US document with neither barcode nor MRZ', () => {
    const back = makeBackResult({
      qr_payload: null,
      barcode_format: null,
      raw_barcode_data: null,
      mrz_result: null,
    });

    const result = evaluateGate2(back, makeFrontResult(), 'DE');
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_BARCODE_NOT_FOUND');
    expect(result.rejection_detail).toContain('MRZ');
  });

  it('FAILS for non-US document with invalid MRZ checksums', () => {
    const back = makeBackResult({
      qr_payload: null,
      barcode_format: 'MRZ_TD1',
      raw_barcode_data: null,
      mrz_result: {
        raw_lines: ['IDDEUDOE<<JOHN<<<<<<<<<<<<<<<'],
        checksums_valid: false,
      },
    });

    const result = evaluateGate2(back, makeFrontResult(), 'DE');
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_MRZ_UNREADABLE');
  });

  it('treats null issuingCountry as US (backward compatibility)', () => {
    const back = makeBackResult({ qr_payload: null, barcode_format: null });
    const result = evaluateGate2(back, makeFrontResult(), null);
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_BARCODE_NOT_FOUND');
  });

  it('treats undefined issuingCountry as US (backward compatibility)', () => {
    const back = makeBackResult({ qr_payload: null, barcode_format: null });
    const result = evaluateGate2(back, makeFrontResult(), undefined);
    expect(result.passed).toBe(false);
    expect(result.rejection_reason).toBe('BACK_BARCODE_NOT_FOUND');
  });
});

describe('Gate 2 — MRZ misread vs tampering', () => {
  // SYNTHETIC values. Front: AB1234567, born 1990-01-15, expires 2030-12-31.
  const mrz = (fields: Record<string, string>, check_digits: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
    makeBackResult({
      qr_payload: null, barcode_format: 'MRZ_TD1', raw_barcode_data: null,
      mrz_result: { raw_lines: ['L1', 'L2', 'L3'], checksums_valid: false, fields, check_digits, ...extra } as any,
    });

  it('a misread date of birth (its own check digit fails) asks for a retake, not tampering', () => {
    const back = mrz(
      { document_number: 'AB1234567', date_of_birth: '1990-01-18', expiry_date: '2030-12-31' },
      { document_number: true, date_of_birth: false, expiry_date: true, composite: false },
    );
    const result = evaluateGate2(back, makeFrontResult(), 'BG');
    expect(result.rejection_reason).toBe('BACK_MRZ_UNREADABLE');
    expect(result.rejection_detail).toContain('date_of_birth, composite');
    expect(result.rejection_detail).toContain('document_number, expiry_date agree with the front');
  });

  it('only the composite check failing, all fields agreeing: retake', () => {
    const back = mrz(
      { document_number: 'AB1234567', date_of_birth: '1990-01-15', expiry_date: '2030-12-31' },
      { document_number: true, date_of_birth: true, expiry_date: true, composite: false },
    );
    expect(evaluateGate2(back, makeFrontResult(), 'BG').rejection_reason).toBe('BACK_MRZ_UNREADABLE');
  });

  it('ignores the O/0 look-alike when comparing document numbers', () => {
    const back = mrz(
      { document_number: 'AA0O00000', date_of_birth: '1990-01-15' },
      { document_number: true, date_of_birth: true, composite: false },
    );
    const front = makeFrontResult();
    (front.ocr as Record<string, unknown>).id_number = 'AA0000000';
    expect(evaluateGate2(back, front, 'BG').rejection_reason).toBe('BACK_MRZ_UNREADABLE');
  });

  it('a field that passed its own check digit but contradicts the front is still tampering', () => {
    const back = mrz(
      { document_number: 'AB1234567', date_of_birth: '1985-03-02', expiry_date: '2030-12-31' },
      { document_number: true, date_of_birth: true, expiry_date: true, composite: false },
    );
    const result = evaluateGate2(back, makeFrontResult(), 'BG');
    expect(result.rejection_reason).toBe('BACK_MRZ_CHECKSUM_FAILED');
    expect(result.rejection_detail).toContain('date_of_birth contradict the front');
  });

  it('an MRZ found but not parseable asks for a retake', () => {
    const back = mrz({}, {}, { parsed: false });
    expect(evaluateGate2(back, makeFrontResult(), 'BG').rejection_reason).toBe('BACK_MRZ_UNREADABLE');
  });

  it('valid check digits still pass', () => {
    const back = mrz({ document_number: 'AB1234567' }, { document_number: true }, { checksums_valid: true });
    expect(evaluateGate2(back, makeFrontResult(), 'BG').passed).toBe(true);
  });
});
