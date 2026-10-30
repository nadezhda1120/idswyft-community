/**
 * Position-aware correction of OCR misreads in MRZ lines (ICAO 9303).
 *
 * Every MRZ position has a fixed character class: dates and check digits are
 * digits, country codes and sex are letters, unused optional data is '<'. OCR
 * confuses characters across those classes (0/O/D, 1/I, 8/B, 5/S, '<' read as
 * K or L), so a character outside its position's class is mapped to its
 * look-alike in the right class. The caller parses both the original and the
 * corrected lines and keeps whichever has more valid check digits, so a
 * correction is only ever accepted when the check digits confirm it.
 *
 * Pure and deterministic. Names are never changed (a letter there is a letter).
 */

type Zone = 'digit' | 'check' | 'alpha' | 'sex' | 'optional' | 'names' | 'alnum';
type Layout = Array<Array<[from: number, to: number, zone: Zone]>>;

// [start, end) per line
const TD1: Layout = [
  [[0, 2, 'alnum'], [2, 5, 'alpha'], [5, 14, 'alnum'], [14, 15, 'check'], [15, 30, 'optional']],
  [[0, 6, 'digit'], [6, 7, 'check'], [7, 8, 'sex'], [8, 14, 'digit'], [14, 15, 'check'],
    [15, 18, 'alpha'], [18, 29, 'optional'], [29, 30, 'check']],
  [[0, 30, 'names']],
];
const TD2: Layout = [
  [[0, 2, 'alnum'], [2, 5, 'alpha'], [5, 36, 'names']],
  [[0, 9, 'alnum'], [9, 10, 'check'], [10, 13, 'alpha'], [13, 19, 'digit'], [19, 20, 'check'], [20, 21, 'sex'],
    [21, 27, 'digit'], [27, 28, 'check'], [28, 35, 'optional'], [35, 36, 'check']],
];
const TD3: Layout = [
  [[0, 2, 'alnum'], [2, 5, 'alpha'], [5, 44, 'names']],
  [[0, 9, 'alnum'], [9, 10, 'check'], [10, 13, 'alpha'], [13, 19, 'digit'], [19, 20, 'check'], [20, 21, 'sex'],
    [21, 27, 'digit'], [27, 28, 'check'], [28, 42, 'optional'], [42, 43, 'check'], [43, 44, 'check']],
];

/** Letter read where a digit must be */
const TO_DIGIT: Record<string, string> = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', T: '7', B: '8' };
/** Digit read where a letter must be */
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };

function layoutFor(lines: string[]): Layout | null {
  if (lines.length === 3 && lines.every(l => l.length === 30)) return TD1;
  if (lines.length === 2 && lines.every(l => l.length === 36)) return TD2;
  if (lines.length === 2 && lines.every(l => l.length === 44)) return TD3;
  return null;
}

/**
 * Fillers that OCR read as K or L. In optional data, a run of 3+ characters made
 * only of '<', 'K' and 'L' at the end is fillers ('<<<<' read as 'KLKL'). In
 * names only a lone K/L right after a name and its separator, followed by
 * fillers, is noise ("GEORGIEVA<K<<"); a name ending in K or L ("KOL<<<") or an
 * initial after the surname separator ("IVANOV<<K<<") is never touched.
 */
function fixTrailingFillers(chunk: string, zone: Zone): string {
  if (zone === 'names') return chunk.replace(/(?<=[A-Z]<)[KL](?=<<+$)/, '<');
  const m = /[<KL]{3,}$/.exec(chunk);
  return m ? chunk.slice(0, m.index) + '<'.repeat(m[0].length) : chunk;
}

function fixChar(ch: string, zone: Zone): string {
  switch (zone) {
    case 'digit':
      return TO_DIGIT[ch] ?? ch;
    case 'check':
      // A check digit is a digit, or '<' when its field is empty
      return ch === '<' ? ch : TO_DIGIT[ch] ?? ch;
    case 'alpha':
      return TO_LETTER[ch] ?? ch;
    case 'sex':
      return ch === 'M' || ch === 'F' || ch === '<' ? ch : ({ H: 'M', N: 'M', E: 'F', P: 'F' } as Record<string, string>)[ch] ?? ch;
    default:
      return ch;
  }
}

export interface MrzCorrection {
  lines: string[];
  /** Positions changed, e.g. "line 2, col 4: O→0" */
  changes: string[];
}

/**
 * Correct OCR misreads by position. Returns the lines unchanged for an unknown layout.
 * optionalDigits: also read letters in the optional data as digits (the Bulgarian
 * ЕГН lives there); a separate candidate, since other countries put letters there.
 */
export function correctMrzLines(lines: string[], opts: { optionalDigits?: boolean } = {}): MrzCorrection {
  const layout = layoutFor(lines);
  if (!layout) return { lines, changes: [] };
  const changes: string[] = [];
  const out = lines.map((line, li) => {
    let result = '';
    for (const [from, to, zone] of layout[li]) {
      let chunk = [...line.slice(from, to)].map(ch => fixChar(ch, zone)).join('');
      if (zone === 'optional' || zone === 'names') chunk = fixTrailingFillers(chunk, zone);
      if (zone === 'optional' && opts.optionalDigits) chunk = [...chunk].map(ch => TO_DIGIT[ch] ?? ch).join('');
      result += chunk;
    }
    for (let i = 0; i < line.length; i++) {
      if (result[i] !== line[i]) changes.push(`line ${li + 1}, col ${i + 1}: ${line[i]}→${result[i]}`);
    }
    return result;
  });
  return { lines: out, changes };
}

/** mrz library detail field → name used in API responses */
export const CHECK_DIGIT_NAMES: Record<string, string> = {
  documentNumberCheckDigit: 'document_number',
  birthDateCheckDigit: 'date_of_birth',
  expirationDateCheckDigit: 'expiry_date',
  personalNumberCheckDigit: 'personal_number',
  compositeCheckDigit: 'composite',
};

/**
 * Cyrillic letters a Cyrillic recognizer puts into MRZ lines, mapped to the Latin
 * letter they stand for. Identical twins (А, В, Е …) plus shape look-alikes with
 * no Latin twin: Л for L, И for a mirrored N, П for N. MRZ text is Latin only.
 */
const MRZ_CYRILLIC: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
  І: 'I', Ј: 'J', Ѕ: 'S', Л: 'L', И: 'N', П: 'N', З: '3', Б: '6', Д: 'D', Г: 'F',
};

/**
 * A line shaped like MRZ (25–46 characters without spaces, at least two '<',
 * mostly A–Z, 0–9 and '<') with a few Cyrillic letters in it is returned with
 * those letters mapped to Latin; any other line is returned unchanged. Without
 * this, one "Л" read for "L" in a name made the whole MRZ undetectable. Numbers
 * stay covered by the check digits; names have none, so a wrong letter there
 * shows up as a name mismatch against the front and goes to review.
 */
export function latinizeMrzLine(line: string): string {
  const compact = line.replace(/\s/g, '');
  if (compact.length < 25 || compact.length > 46 || (compact.match(/</g) ?? []).length < 2) return line;
  const cyrillic = compact.match(/[Ѐ-ӿ]/g) ?? [];
  if (cyrillic.length === 0 || cyrillic.length > 4) return line;
  const mrzLike = (compact.match(/[A-Z0-9<]/g) ?? []).length;
  if (mrzLike + cyrillic.length < compact.length * 0.95) return line;
  return line.toUpperCase().replace(/[Ѐ-ӿ]/g, ch => MRZ_CYRILLIC[ch] ?? ch);
}
