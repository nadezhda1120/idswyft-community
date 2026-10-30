import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
// mrz.ts re-exports alpha3ToAlpha2 from a module that imports the shared package
vi.mock('@idswyft/shared', () => ({ transliterateBulgarian: (s: string) => s }));

import { correctMrzLines, latinizeMrzLine } from '../mrzCorrect.js';
import { parseMRZLines, extractMRZFromText, fitMrzLengths } from '../mrz.js';

// MRZ of the public Wikimedia specimen cards (fictitious holders). Both are valid.
const BG_2024 = ['IDBGRAA00000000<<<<<<<<<<<<<<<', '9508015F3406175BGR9508010133<0', 'IVANOVA<<SLAVINA<GEORGIEVA<<<<'];
const BG_2010 = ['IDBGR6000000002<<<<<<<<<<<<<<<', '8508018F1908011BGR8508010133<1', 'IVANOVA<<MARITSA<RADNEVA<<<<<<'];

const withLine = (lines: string[], i: number, line: string) => lines.map((l, j) => (j === i ? line : l));

describe('correctMrzLines (by position)', () => {
  it('reads letters as digits in dates and check digits', () => {
    const { lines, changes } = correctMrzLines(withLine(BG_2024, 1, '95O8O1SF34O6175BGR9508010133<0'));
    expect(lines[1]).toBe(BG_2024[1]);
    expect(changes).toEqual(['line 2, col 3: O→0', 'line 2, col 5: O→0', 'line 2, col 7: S→5', 'line 2, col 11: O→0']);
  });

  it('reads digits as letters in country codes', () => {
    expect(correctMrzLines(withLine(BG_2024, 1, '9508015F3406175B6R9508010133<0')).lines[1]).toBe(BG_2024[1]);
    expect(correctMrzLines(withLine(BG_2010, 0, 'IDB6R6000000002<<<<<<<<<<<<<<<')).lines[0]).toBe(BG_2010[0]);
  });

  it('turns a run of K/L read for fillers back into fillers', () => {
    expect(correctMrzLines(withLine(BG_2024, 0, 'IDBGRAA00000000KLKLKLKLLLKKKKL')).lines[0]).toBe(BG_2024[0]);
    expect(correctMrzLines(withLine(BG_2024, 2, 'IVANOVA<<SLAVINA<GEORGIEVA<K<<')).lines[2]).toBe(BG_2024[2]);
  });

  it('never changes letters inside names', () => {
    const names = 'PAVEL<<MIKHAIL<KOL<<<<<<<<<<<<';
    expect(correctMrzLines(withLine(BG_2024, 2, names)).lines[2]).toBe(names);
    const initial = 'IVANOV<<K<<<<<<<<<<<<<<<<<<<<<';
    expect(correctMrzLines(withLine(BG_2024, 2, initial)).lines[2]).toBe(initial);
  });

  it('leaves an unknown layout alone', () => {
    expect(correctMrzLines(['SHORT', 'LINES'])).toEqual({ lines: ['SHORT', 'LINES'], changes: [] });
  });
});

describe('parseMRZLines', () => {
  it('reports every check digit of a valid MRZ', () => {
    const r = parseMRZLines(BG_2024)!;
    expect(r.check_digits_valid).toBe(true);
    expect(r.check_digits).toEqual({ document_number: true, date_of_birth: true, expiry_date: true, composite: true });
    expect(r.corrections).toEqual([]);
  });

  it('fixes a misread date of birth when the check digits confirm it', () => {
    const r = parseMRZLines(withLine(BG_2024, 1, '95O8O15F3406175BGR9508010133<0'))!;
    expect(r.check_digits_valid).toBe(true);
    expect(r.fields.date_of_birth).toBe('1995-08-01');
    expect(r.corrections).toEqual(['line 2, col 3: O→0', 'line 2, col 5: O→0']);
    expect(r.raw_lines[1]).toBe(BG_2024[1]);
  });

  it('fixes a misread ЕГН in the optional data', () => {
    const r = parseMRZLines(withLine(BG_2024, 1, '9508015F3406175BGR95O8O1O133<0'))!;
    expect(r.check_digits_valid).toBe(true);
    expect(r.fields.personal_number).toBe('9508010133');
  });

  it('fixes D read for 0 in the document number, with fillers read as K/L', () => {
    const r = parseMRZLines(withLine(BG_2024, 0, 'IDBGRAAOOOODOO0KLKLKLKLKLKLKLK'))!;
    expect(r.check_digits_valid).toBe(true);
    expect(r.fields.document_number).toBe('AA0000000');
  });

  it('reports which check digit fails when a digit is genuinely different', () => {
    const r = parseMRZLines(withLine(BG_2010, 1, '8508028F1908011BGR8508010133<1'))!;
    expect(r.check_digits_valid).toBe(false);
    expect(r.check_digits.date_of_birth).toBe(false);
    expect(r.check_digits.document_number).toBe(true);
    expect(r.check_digits.expiry_date).toBe(true);
  });
});

describe('MRZ line length', () => {
  it('fits a line with extra or missing fillers', () => {
    expect(fitMrzLengths('IDBGRAA00000000<<<<<<<<<<<<<<<<<').get(30)).toBe(BG_2024[0]);
    expect(fitMrzLengths('IDBGRAA00000000<<<<<<<<<<<<<<').get(30)).toBe(BG_2024[0]);
    expect(fitMrzLengths('IDBGRAA00000000KLKLKLKLKLKLKLKLLK').get(30)).toBe('IDBGRAA00000000KLKLKLKLKLKLKLK');
  });

  it('does not cut into data', () => {
    expect(fitMrzLengths('IDBGRAA00000000ABCDEFGHIJKLMNOPQ').size).toBe(0);
  });

  it('finds a TD1 block whose first line was read too long', () => {
    const text = ['РЕПУБЛИКА БЪЛГАРИЯ', 'IDBGRAA00000000KLKLKLKLKLKLKLKLLLK', BG_2024[1], BG_2024[2]].join('\n');
    const r = extractMRZFromText(text)!;
    expect(r.format).toBe('TD1');
    expect(r.check_digits_valid).toBe(true);
  });

  it('prefers lines read at their exact length', () => {
    const r = extractMRZFromText(BG_2010.join('\n'))!;
    expect(r.raw_lines).toEqual(BG_2010);
  });
});

describe('Cyrillic letters in MRZ lines', () => {
  it('maps a Cyrillic letter in a name line to Latin', () => {
    expect(latinizeMrzLine('PETROV<<IЛIA<IVANOV<<<<<<<<<<<')).toBe('PETROV<<ILIA<IVANOV<<<<<<<<<<<');
    // The Cyrillic model writes И for the Latin I (real card: "ИLIA")
    expect(latinizeMrzLine('PETROV<<ИLIA<IVANOV<<<<<<<<<<<')).toBe('PETROV<<ILIA<IVANOV<<<<<<<<<<<');
    expect(latinizeMrzLine('IVANOVA<<SЛAVINA<GEORGIEVA<<<<')).toBe('IVANOVA<<SLAVINA<GEORGIEVA<<<<');
  });

  it('leaves ordinary Cyrillic text alone', () => {
    expect(latinizeMrzLine('Постоянен адрес/Residence обл.СОФИЯ')).toBe('Постоянен адрес/Residence обл.СОФИЯ');
    expect(latinizeMrzLine('IVANOVA SLAVINA')).toBe('IVANOVA SLAVINA');
  });

  it('finds the TD1 block when one name line carries a Cyrillic letter', () => {
    const text = [BG_2024[0], BG_2024[1], 'IVANOVA<<SЛAVINA<GEORGIEVA<<<<'].join('\n');
    const r = extractMRZFromText(text)!;
    expect(r.format).toBe('TD1');
    expect(r.check_digits_valid).toBe(true);
    expect(r.fields.first_name).toContain('SLAVINA');
  });
});
