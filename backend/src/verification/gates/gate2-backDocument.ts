/**
 * Gate 2 — Back Document Integrity
 *
 * FAIL if:
 *   - US document: No barcode found (qr_payload is null) AND no MRZ
 *   - Non-US document: Neither barcode NOR MRZ found
 *   - MRZ checksums failed (checksums_valid === false):
 *       BACK_MRZ_UNREADABLE when the failure is explained by reading — the MRZ could
 *         not be parsed, or every MRZ field whose own check digit passed agrees with
 *         the front — so the user is asked to retake the photo;
 *       BACK_MRZ_CHECKSUM_FAILED when such a field contradicts the front
 *   - Front MRZ and back MRZ disagree (BACK_MRZ_BARCODE_MISMATCH)
 *
 * PASS if:
 *   - Barcode decoded and all MRZ checks pass, OR
 *   - Non-US document with valid MRZ (barcode not required)
 */

import type { BackExtractionResult, FrontExtractionResult, GateResult } from '@idswyft/shared';

type MrzForGate = NonNullable<BackExtractionResult['mrz_result']> & {
  check_digits?: Record<string, boolean>;
  parsed?: boolean;
};

/** MRZ fields with their own check digit, and where the front keeps the same value */
const CHECKED_FIELDS: Array<{ mrz: string; front: string[]; date: boolean }> = [
  { mrz: 'document_number', front: ['id_number', 'document_number'], date: false },
  { mrz: 'date_of_birth', front: ['date_of_birth'], date: true },
  { mrz: 'expiry_date', front: ['expiry_date', 'expiration_date'], date: true },
];

// Dates compare by digits; document numbers ignore the O/0 look-alike
const normalize = (value: unknown, date: boolean) => {
  const s = String(value ?? '').toUpperCase();
  return date ? s.replace(/\D/g, '') : s.replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
};

/**
 * Compare the MRZ with the front, using only fields whose own check digit passed
 * (a field with a failed check digit is the unreliable one). Deterministic.
 */
export function mrzAgreementWithFront(mrz: MrzForGate, front: FrontExtractionResult) {
  const ocr = (front.ocr ?? {}) as Record<string, unknown>;
  const fields = (mrz.fields ?? {}) as Record<string, string | null | undefined>;
  const agree: string[] = [];
  const disagree: string[] = [];
  for (const { mrz: key, front: frontKeys, date } of CHECKED_FIELDS) {
    if (mrz.check_digits && mrz.check_digits[key] !== true) continue;
    const mrzValue = normalize(fields[key], date);
    const frontValue = normalize(frontKeys.map(k => ocr[k]).find(v => v), date);
    if (!mrzValue || !frontValue) continue;
    (mrzValue === frontValue ? agree : disagree).push(key);
  }
  return { agree, disagree };
}

export function evaluateGate2(
  back: BackExtractionResult,
  front: FrontExtractionResult,
  issuingCountry?: string | null,
): GateResult {
  const isUS = !issuingCountry || issuingCountry === 'US';
  const hasBarcode = !!(back.qr_payload || back.barcode_format);
  const hasMRZ = !!(back.mrz_result && back.mrz_result.raw_lines.length > 0);
  const isMRZFormat = back.barcode_format?.startsWith('MRZ_');

  // Check barcode/MRZ presence
  if (!hasBarcode && !hasMRZ && !isMRZFormat) {
    if (isUS) {
      // US documents require a barcode (PDF417)
      return {
        passed: false,
        rejection_reason: 'BACK_BARCODE_NOT_FOUND',
        rejection_detail: 'No barcode (PDF417, QR, DataMatrix) detected on back of document',
        user_message: 'We could not read the barcode on the back of your ID. Please retake the photo ensuring the barcode is clearly visible.',
      };
    } else {
      // Non-US: accept MRZ as alternative, but fail if neither found
      return {
        passed: false,
        rejection_reason: 'BACK_BARCODE_NOT_FOUND',
        rejection_detail: 'No barcode or MRZ detected on back of document',
        user_message: 'We could not read the barcode or machine-readable zone on the back of your ID. Please retake the photo ensuring the back is clearly visible.',
      };
    }
  }

  // Check MRZ checksums if present
  if (back.mrz_result && !back.mrz_result.checksums_valid) {
    const mrz = back.mrz_result as MrzForGate;
    const failed = Object.entries(mrz.check_digits ?? {}).filter(([, ok]) => !ok).map(([name]) => name);
    const failedText = failed.length ? `check digit(s) failed: ${failed.join(', ')}` : 'check digits failed';
    const { agree, disagree } = mrzAgreementWithFront(mrz, front);

    if (mrz.parsed === false || disagree.length === 0) {
      return {
        passed: false,
        rejection_reason: 'BACK_MRZ_UNREADABLE',
        rejection_detail: mrz.parsed === false
          ? 'MRZ found but could not be parsed — treated as a misread'
          : `MRZ ${failedText}; ${agree.length ? `${agree.join(', ')} agree with the front` : 'no checked field to compare'} — treated as a misread`,
        user_message: 'We could not read the code at the bottom of the back of your ID clearly. Please retake the photo in good light, without glare, with the whole back of the card in focus.',
      };
    }
    return {
      passed: false,
      rejection_reason: 'BACK_MRZ_CHECKSUM_FAILED',
      rejection_detail: `MRZ ${failedText}, and ${disagree.join(', ')} contradict the front — possible tampering`,
      user_message: 'We detected an issue with your document. Please ensure you are using an original, unaltered ID.',
    };
  }

  // Check front MRZ vs back MRZ consistency
  if (front.mrz_from_front && front.mrz_from_front.length > 0 && back.mrz_result) {
    const frontMrzJoined = front.mrz_from_front.join('').replace(/[^A-Z0-9<]/g, '');
    const backMrzJoined = back.mrz_result.raw_lines.join('').replace(/[^A-Z0-9<]/g, '');

    if (frontMrzJoined !== backMrzJoined) {
      return {
        passed: false,
        rejection_reason: 'BACK_MRZ_BARCODE_MISMATCH',
        rejection_detail: `Front MRZ does not match back MRZ — strong fraud signal`,
        user_message: 'The front and back of your document do not appear to match. Please ensure both images are from the same ID.',
      };
    }
  }

  return {
    passed: true,
    rejection_reason: null,
    rejection_detail: null,
    user_message: null,
  };
}
