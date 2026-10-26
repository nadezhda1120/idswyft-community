import { vi } from 'vitest';
import type { FrontExtractionResult, BackExtractionResult, LiveCaptureResult } from '@idswyft/shared';
import type { StatelessDeps } from '../verify.js';

// SYNTHETIC values only — never real card data.

export const front: FrontExtractionResult = {
  ocr: {
    full_name: 'JOHN DOE',
    date_of_birth: '1990-01-15',
    id_number: 'AB1234567',
    expiry_date: '2030-12-31',
    nationality: 'USA',
    raw_text: 'JOHN DOE AB1234567',
  },
  face_embedding: [0.1, 0.2, 0.3],
  face_confidence: 0.92,
  ocr_confidence: 0.87,
  mrz_from_front: null,
};

export const back: BackExtractionResult = {
  qr_payload: {
    full_name: 'JOHN DOE',
    first_name: 'JOHN',
    last_name: 'DOE',
    date_of_birth: '1990-01-15',
    id_number: 'AB1234567',
    expiry_date: '2030-12-31',
    nationality: 'USA',
  },
  mrz_result: null,
  barcode_format: 'PDF417',
  raw_barcode_data: 'DAQAB1234567',
};

export const live: LiveCaptureResult = {
  face_embedding: [0.1, 0.2, 0.31],
  face_confidence: 0.95,
  liveness_passed: true,
  liveness_score: 0.88,
};

export function mockDeps(overrides: Partial<StatelessDeps> = {}) {
  return {
    extractFront: vi.fn(async () => structuredClone(front)),
    extractBack: vi.fn(async () => structuredClone(back)),
    extractLive: vi.fn(async () => structuredClone(live)),
    faceMatchThreshold: 0.6,
    ...overrides,
  };
}

/** A head-turn capture payload that passes the schema (5 frames). */
export function headTurn(direction: 'left' | 'right') {
  const phases = ['turn_start', 'turn_peak', 'turn_peak', 'turn_return', 'turn_return'] as const;
  return {
    challenge_type: 'head_turn',
    challenge_direction: direction,
    frames: phases.map((phase, i) => ({ frame_base64: 'AAAA', timestamp: i * 100, phase })),
    start_timestamp: 0,
    end_timestamp: 500,
  };
}
