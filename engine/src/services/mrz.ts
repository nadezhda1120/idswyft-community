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
import { correctMrzLines, CHECK_DIGIT_NAMES } from './mrzCorrect.js';

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
  /** Result of each check digit: document_number, date_of_birth, expiry_date, composite (+ personal_number in TD3) */
  check_digits: Record<string, boolean>;
  /** OCR misreads corrected by position and confirmed by the check digits ("line 2, col 4: O→0") */
  corrections: string[];
  /** The lines the fields come from (after corrections) */
  raw_lines: string[];
}

// MRZ line length → expected format
const MRZ_LINE_LENGTHS = new Set([30, 36, 44]);

/**
 * OCR often reads fillers too many or too few at the end of an MRZ line
 * ("IDBGRAA0O00OO00<<<<<<<<<<<<<<<<" — 31 chars), and reads runs of '<' as K/L
 * ("IDBGRAA0000000KLKLKLKLKLKLKLKLLLK" — 33). Returns every valid length the line
 * can be fitted to by trimming or padding its trailing run of fillers (or K/L
 * read for them) — never by touching other characters. The check digits still
 * decide whether a fitted block is accepted.
 */
export function fitMrzLengths(line: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!/^[A-Z0-9<]+$/.test(line)) return out;
  if (MRZ_LINE_LENGTHS.has(line.length)) out.set(line.length, line);
  const tail = /[<KL]*$/.exec(line)![0].length;
  for (const len of MRZ_LINE_LENGTHS) {
    if (out.has(len)) continue;
    const excess = line.length - len;
    // Trim: everything cut is part of the trailing filler run, and something of the run stays
    if (excess > 0 && excess <= 12 && tail > excess) out.set(len, line.slice(0, len));
    // Pad: up to 3 missing fillers on a line that ends in one
    if (excess < 0 && excess >= -3 && tail >= 1) out.set(len, line + '<'.repeat(-excess));
  }
  return out;
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

  // MRZ lines: uppercase letters, digits, and < filler only; each line may fit
  // several lengths, so look for a consistent block per format
  const fitted = lines.map(line => fitMrzLengths(line.replace(/\s/g, '')));
  if (fitted.filter(f => f.size > 0).length < 2) return null;

  // TD1 = 3 lines of 30, TD2 = 2 lines of 36, TD3 = 2 lines of 44.
  // Lines read at their exact length win; fitted lengths are the fallback.
  for (const exactOnly of [true, false]) {
    for (const [len, count] of [[30, 3], [36, 2], [44, 2]] as const) {
      const group = fitted
        .map(f => f.get(len))
        .filter((l, i): l is string => !!l && (!exactOnly || lines[i].replace(/\s/g, '').length === len));
      if (group.length >= count) return group.slice(0, count);
    }
  }

  return null;
}

/**
 * Parse MRZ lines using the `mrz` library.
 * Returns structured fields or null if parsing fails.
 */
export function parseMRZLines(lines: string[]): MRZParseResult | null {
  try {
    const { result, lines: used, changes } = bestReading(lines);

    const fields = result.fields;

    return {
      format: result.format,
      valid: result.valid,
      check_digits_valid: result.valid,
      check_digits: checkDigitResults(result),
      corrections: changes,
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
      raw_lines: used,
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

const validCount = (r: ParseResult) => r.details.filter(d => d.valid).length;

/** Each check digit's result, by API name. */
function checkDigitResults(result: ParseResult): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const d of result.details) {
    const name = CHECK_DIGIT_NAMES[d.field as string];
    if (name) out[name] = d.valid;
  }
  return out;
}

/**
 * OCR often confuses O and 0 (and D or Q for 0) in the document number, which the
 * `mrz` autocorrect cannot fix because document numbers may contain letters (e.g.
 * Bulgarian "AA0O00OO0"). When the check digits fail, try every 0/letter
 * combination in the document number field and keep the variant with the most
 * valid check digits. Deterministic: the check digits decide, never a guess.
 */
function bestDocumentNumberVariant(lines: string[], original: ParseResult): { result: ParseResult; lines: string[] } {
  if (original.valid) return { result: original, lines };
  const row = lines.length === 3 ? 0 : 1;   // TD1: line 1, TD2/TD3: line 2
  const start = lines.length === 3 ? 5 : 0;
  const line = lines[row] ?? '';
  // The 9-character number and its check digit (a check digit is always numeric).
  const positions = [...line.slice(start, start + 10)]
    .map((c, i) => ('O0DQ'.includes(c) ? start + i : -1))
    .filter(i => i >= 0)
    .slice(0, 10);
  if (positions.length === 0) return { result: original, lines };

  let best = { result: original, lines };
  for (let mask = 0; mask < 1 << positions.length; mask++) {
    const chars = [...line];
    positions.forEach((p, bit) => {
      const read = line[p];
      chars[p] = mask & (1 << bit) ? (read === '0' ? 'O' : read) : '0';
    });
    const candidate = chars.join('');
    if (candidate === line) continue;
    try {
      const variant = [...lines];
      variant[row] = candidate;
      const parsed = parseMRZ(variant, { autocorrect: true });
      if (validCount(parsed) > validCount(best.result)) best = { result: parsed, lines: variant };
      if (best.result.valid) break;
    } catch { /* variant not parseable */ }
  }
  return best;
}

/** The `mrz` library's own autocorrections (letters in digit fields), applied to the lines and listed. */
function applyLibraryCorrections(lines: string[], result: ParseResult): { lines: string[]; changes: string[] } {
  const out = lines.map(l => [...l]);
  const changes: string[] = [];
  for (const d of result.details) {
    for (const c of (d as { autocorrect?: Array<{ line: number; column: number; original: string; corrected: string }> }).autocorrect ?? []) {
      if (out[c.line]?.[c.column] !== c.original) continue;
      out[c.line][c.column] = c.corrected;
      changes.push(`line ${c.line + 1}, col ${c.column + 1}: ${c.original}→${c.corrected}`);
    }
  }
  return { lines: out.map(l => l.join('')), changes };
}

/**
 * Parse the lines as read, corrected by position, and corrected with digits in
 * the optional data; keep the reading with the most valid check digits (the
 * earliest on a tie, i.e. the fewest changes). Corrections are reported.
 */
function bestReading(lines: string[]): { result: ParseResult; lines: string[]; changes: string[] } {
  const readings = [
    { lines, changes: [] as string[] },
    correctMrzLines(lines),
    correctMrzLines(lines, { optionalDigits: true }),
  ];
  let best: { result: ParseResult; lines: string[]; changes: string[] } | null = null;
  const seen = new Set<string>();
  for (const reading of readings) {
    const key = reading.lines.join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    let parsed: { result: ParseResult; lines: string[] };
    try {
      parsed = bestDocumentNumberVariant(reading.lines, parseMRZ(reading.lines, { autocorrect: true }));
    } catch {
      continue;
    }
    if (!best || validCount(parsed.result) > validCount(best.result)) {
      const extra = parsed.lines.flatMap((l, li) => [...l].flatMap((ch, i) =>
        ch !== reading.lines[li][i] ? [`line ${li + 1}, col ${i + 1}: ${reading.lines[li][i]}→${ch}`] : []));
      const library = applyLibraryCorrections(parsed.lines, parsed.result);
      best = { result: parsed.result, lines: library.lines, changes: [...reading.changes, ...extra, ...library.changes] };
    }
    if (best.result.valid) break;
  }
  if (!best) throw new Error('MRZ could not be parsed');
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
