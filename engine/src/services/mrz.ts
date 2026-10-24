/**
 * MRZ (Machine Readable Zone) Service
 *
 * Wraps the `mrz` library to parse all 3 ICAO MRZ formats:
 *   - TD1 (ID cards, 3 lines × 30 chars)
 *   - TD2 (ID cards, 2 lines × 36 chars)
 *   - TD3 (Passports, 2 lines × 44 chars)
 *
 * Also handles detection of MRZ patterns in raw OCR text.
 */

import { parse as parseMRZ } from 'mrz';
import type { ParseResult, MRZFormat } from 'mrz';
import { logger } from '@/utils/logger.js';

export interface MRZParseResult {
  format: MRZFormat;
  valid: boolean;
  check_digits_valid: boolean;
  fields: {
    document_number: string | null;
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
    date_of_birth: string | null;   // YYYY-MM-DD
    expiry_date: string | null;     // YYYY-MM-DD
    nationality: string | null;     // ISO alpha-3
    issuing_country: string | null; // ISO alpha-3 (issuingState from MRZ)
    sex: string | null;
    /** Personal / optional data (e.g. the Bulgarian ЕГН), fillers removed. */
    personal_number: string | null;
  };
  raw_lines: string[];
}

// MRZ line length → expected format
const MRZ_LINE_LENGTHS = new Set([30, 36, 44]);

/**
 * OCR often reads one filler too many or too few at the end of an MRZ line
 * ("IDBGRAA0O00OO00<<<<<<<<<<<<<<<<" — 31 chars). A line within one character of a
 * valid length that ends in fillers is trimmed / padded to that length; the
 * check digits still decide whether the result is accepted.
 */
function fitMrzLength(line: string): string {
  if (MRZ_LINE_LENGTHS.has(line.length) || !/^[A-Z0-9<]+$/.test(line)) return line;
  for (const len of MRZ_LINE_LENGTHS) {
    if (line.length === len + 1 && line.endsWith('<<')) return line.slice(0, len);
    if (line.length === len - 1 && line.endsWith('<')) return line + '<';
  }
  return line;
}

/**
 * Detect MRZ-like lines in raw OCR text.
 * MRZ lines consist of uppercase letters, digits, and `<` filler characters.
 * Returns the detected lines grouped by line length, or null if none found.
 */
export function detectMRZInText(rawText: string): string[] | null {
  if (!rawText) return null;

  const lines = rawText.split('\n').map(l => l.trim());
  const mrzCandidates: string[] = [];

  for (const line of lines) {
    // MRZ lines: uppercase letters, digits, and < filler only
    const cleaned = fitMrzLength(line.replace(/\s/g, ''));
    if (cleaned.length >= 30 && /^[A-Z0-9<]+$/.test(cleaned) && MRZ_LINE_LENGTHS.has(cleaned.length)) {
      mrzCandidates.push(cleaned);
    }
  }

  if (mrzCandidates.length < 2) return null;

  // Group by line length to find consistent MRZ blocks
  const byLength = new Map<number, string[]>();
  for (const line of mrzCandidates) {
    const len = line.length;
    if (!byLength.has(len)) byLength.set(len, []);
    byLength.get(len)!.push(line);
  }

  // TD1 = 3 lines of 30, TD2 = 2 lines of 36, TD3 = 2 lines of 44
  for (const [len, group] of byLength) {
    if (len === 30 && group.length >= 3) return group.slice(0, 3);
    if ((len === 36 || len === 44) && group.length >= 2) return group.slice(0, 2);
  }

  return null;
}

/**
 * Parse MRZ lines using the `mrz` library.
 * Returns structured fields or null if parsing fails.
 */
export function parseMRZLines(lines: string[]): MRZParseResult | null {
  try {
    const result: ParseResult = bestDocumentNumberVariant(lines, parseMRZ(lines, { autocorrect: true }));

    const fields = result.fields;

    return {
      format: result.format,
      valid: result.valid,
      check_digits_valid: result.valid,
      fields: {
        document_number: fields.documentNumber ?? null,
        first_name: fields.firstName ?? null,
        last_name: fields.lastName ?? null,
        full_name: [fields.firstName, fields.lastName].filter(Boolean).join(' ') || null,
        date_of_birth: normalizeMRZDate(fields.birthDate ?? null, 'birth'),
        expiry_date: normalizeMRZDate(fields.expirationDate ?? null, 'expiry'),
        nationality: fields.nationality ?? null,
        issuing_country: fields.issuingState ?? null,
        sex: fields.sex ?? null,
        personal_number: personalNumberFrom(fields as Record<string, unknown>),
      },
      raw_lines: lines,
    };
  } catch (error) {
    logger.warn('MRZ parsing failed', {
      error: error instanceof Error ? error.message : 'Unknown',
      lineCount: lines.length,
      lineLengths: lines.map(l => l.length),
    });
    return null;
  }
}

/**
 * OCR often confuses O and 0 in the document number, which the `mrz` autocorrect
 * cannot fix because document numbers may contain letters (e.g. Bulgarian
 * "AA0O00OO0"). When the check digits fail, try every O/0 combination in the
 * document number field and keep the variant with the most valid check digits.
 * Deterministic: the check digits decide, never a guess.
 */
function bestDocumentNumberVariant(lines: string[], original: ParseResult): ParseResult {
  if (original.valid) return original;
  const row = lines.length === 3 ? 0 : 1;   // TD1: line 1, TD2/TD3: line 2
  const start = lines.length === 3 ? 5 : 0;
  const line = lines[row] ?? '';
  // The 9-character number and its check digit (a check digit is always numeric).
  const positions = [...line.slice(start, start + 10)]
    .map((c, i) => (c === 'O' || c === '0' ? start + i : -1))
    .filter(i => i >= 0)
    .slice(0, 10);
  if (positions.length === 0) return original;

  const validCount = (r: ParseResult) => r.details.filter(d => d.valid).length;
  let best = original;
  for (let mask = 0; mask < 1 << positions.length; mask++) {
    const chars = [...line];
    positions.forEach((p, bit) => { chars[p] = mask & (1 << bit) ? 'O' : '0'; });
    const candidate = chars.join('');
    if (candidate === line) continue;
    try {
      const variant = [...lines];
      variant[row] = candidate;
      const parsed = parseMRZ(variant, { autocorrect: true });
      if (validCount(parsed) > validCount(best)) best = parsed;
      if (best.valid) break;
    } catch { /* variant not parseable */ }
  }
  return best;
}

/**
 * Personal number from the MRZ: TD3 `personalNumber`, else the TD1/TD2 optional
 * data fields. Fillers are stripped; null when nothing is there.
 */
function personalNumberFrom(fields: Record<string, unknown>): string | null {
  for (const key of ['personalNumber', 'optional2', 'optional1', 'optional']) {
    const raw = fields[key];
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/</g, '').trim();
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Convenience: detect + parse MRZ from raw OCR text in one call.
 */
export function extractMRZFromText(rawText: string): MRZParseResult | null {
  const lines = detectMRZInText(rawText);
  if (!lines) return null;
  return parseMRZLines(lines);
}

/**
 * Resolve the century for a two-digit MRZ year.
 *
 * ICAO 9303 stores years as two digits, so the century must be inferred. A single
 * fixed pivot cannot work for both field types — it is the semantics of the field
 * that decide:
 *
 *   - Birth dates are always in the past. A year above the current two-digit year
 *     must belong to the 1900s (in 2026: `60` → 1960, `05` → 2005).
 *   - Expiry dates are overwhelmingly in the future or recent past. Treating them
 *     with a birth-date pivot turns a valid document into a long-expired one
 *     (in 2026: `31` → 1931 instead of 2031). Only years that would land absurdly
 *     far ahead are read as 1900s, which keeps genuinely ancient documents parseable.
 */
function resolveCentury(yy: number, fieldType: MRZDateField): '19' | '20' {
  const currentYY = new Date().getFullYear() % 100;

  if (fieldType === 'birth') {
    return yy > currentYY ? '19' : '20';
  }

  // expiry: allow a wide forward window before falling back to the 1900s
  return yy > currentYY + 70 ? '19' : '20';
}

type MRZDateField = 'birth' | 'expiry';

/**
 * Convert MRZ date format (YYMMDD) to ISO (YYYY-MM-DD).
 * The `mrz` library returns dates already formatted, but sometimes as YYMMDD.
 *
 * `fieldType` selects the century rule — see resolveCentury().
 */
function normalizeMRZDate(dateStr: string | null, fieldType: MRZDateField = 'birth'): string | null {
  if (!dateStr) return null;

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

  // YYMMDD format from MRZ
  if (/^\d{6}$/.test(dateStr)) {
    const yy = parseInt(dateStr.slice(0, 2));
    const mm = dateStr.slice(2, 4);
    const dd = dateStr.slice(4, 6);
    const century = resolveCentury(yy, fieldType);
    return `${century}${dateStr.slice(0, 2)}-${mm}-${dd}`;
  }

  return dateStr;
}

// Re-export alpha3ToAlpha2 from normalizers for backward compatibility
export { alpha3ToAlpha2 } from '@/verification/cross-validator/normalizers.js';
