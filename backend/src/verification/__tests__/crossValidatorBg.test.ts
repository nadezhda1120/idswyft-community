import { describe, it, expect } from 'vitest';
import { crossValidate } from '../cross-validator/engine.js';
import type { FrontExtractionResult, BackExtractionResult } from '@idswyft/shared';

// SYNTHETIC values only. 9508010139: valid ЕГН, 1995-08-01, F.

function bgFront(overrides: Record<string, unknown> = {}): FrontExtractionResult {
  return {
    ocr: {
      full_name: 'YANA IVANOVA PETROVA', date_of_birth: '1995-08-01', id_number: 'AA1234567',
      expiry_date: '2034-06-16', nationality: 'BGR', issuing_country: 'BG',
      bg_layout: { document: 'id_card', generation: 'id_card_2024', side: 'front' },
      surname_cyrillic: 'ПЕТРОВА', surname_latin: 'PETROVA',
      given_name_cyrillic: 'ЯНА', given_name_latin: 'YANA',
      patronymic_cyrillic: 'ИВАНОВА', patronymic_latin: 'IVANOVA',
      document_number: 'AA1234567', expiration_date: '2034-06-16', personal_number: '9508010139', sex: 'F',
      ...overrides,
    },
    face_embedding: [0.1], face_confidence: 0.9, ocr_confidence: 0.9, mrz_from_front: null,
  } as FrontExtractionResult;
}

function bgBack(mrzOverrides: Record<string, string> = {}): BackExtractionResult {
  const fields = {
    document_number: 'AA1234567', date_of_birth: '1995-08-01', expiry_date: '2034-06-16',
    last_name: 'PETROVA', first_name: 'YANA IVANOVA', sex: 'female', nationality: 'BGR', personal_number: '9508010139',
    ...mrzOverrides,
  };
  return {
    // Bulgarian cards have no barcode: the engine fills qr_payload from the MRZ
    qr_payload: {
      first_name: fields.first_name, last_name: fields.last_name, full_name: `${fields.first_name} ${fields.last_name}`,
      date_of_birth: fields.date_of_birth, id_number: fields.document_number, expiry_date: fields.expiry_date, nationality: 'BGR',
    },
    mrz_result: {
      raw_lines: ['IDBGRAA12345674<<<<<<<<<<<<<<<', '9508015F3406164BGR9508010139<0', 'PETROVA<<YANA<IVANOVA<<<<<<<<<'],
      checksums_valid: true, fields,
      check_digits: { document_number: true, date_of_birth: true, expiry_date: true, composite: true },
    } as BackExtractionResult['mrz_result'],
    barcode_format: 'MRZ_TD1',
    raw_barcode_data: null,
    ocr: { surname_cyrillic: 'ПЕТРОВА' },
  } as BackExtractionResult;
}

describe('Cross-validation — Bulgarian field confirmation', () => {
  it('PASS when every critical field is confirmed', () => {
    const r = crossValidate(bgFront(), bgBack());
    expect(r.verdict).toBe('PASS');
    expect(r.field_confirmation?.all_critical_confirmed).toBe(true);
    expect(r.field_confirmation?.fields.surname.status).toBe('confirmed');
  });

  it('a misread Cyrillic name turns PASS into REVIEW, although the numbers and dates match', () => {
    const r = crossValidate(bgFront({ surname_cyrillic: 'ПЕТРОБА' }), bgBack());
    expect(r.overall_score).toBeGreaterThanOrEqual(0.92);
    expect(r.verdict).toBe('REVIEW');
    expect(r.field_confirmation?.review_fields).toEqual([
      { field: 'surname', status: 'conflict', reason: 'surname: front_cyrillic differs from front_latin, mrz, back_cyrillic' },
    ]);
  });

  it('a failing ЕГН checksum goes to REVIEW', () => {
    const r = crossValidate(bgFront({ personal_number: '9508010138' }), bgBack({ personal_number: '9508010138' }));
    expect(r.verdict).toBe('REVIEW');
    expect(r.field_confirmation?.review_fields.map(f => f.field)).toContain('personal_number');
  });

  it('does not run for other countries', () => {
    const front = bgFront({ issuing_country: 'DE' });
    expect(crossValidate(front, bgBack()).field_confirmation).toBeUndefined();
  });
});
