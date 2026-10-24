/**
 * ЕГН (Единен граждански номер) — Bulgarian Unified Civil Number.
 *
 * Format: YYMMDDSSSC
 *   YYMMDD — date of birth; month + 20 for births in 1800–1899, month + 40 for 2000–2099
 *   SSS    — region / order number; the 9th digit is even for males, odd for females
 *   C      — checksum: Σ(digit_i × weight_i) mod 11 with weights 2,4,8,5,10,9,7,3,6;
 *            a remainder of 10 becomes 0
 *
 * Pure and deterministic.
 */

const EGN_WEIGHTS = [2, 4, 8, 5, 10, 9, 7, 3, 6];

export interface EgnInfo {
  valid: boolean;
  checksum_valid: boolean;
  date_of_birth: string | null; // YYYY-MM-DD
  sex: 'M' | 'F' | null;
}

/** Strip whitespace and keep only digits. */
export function normalizeEgn(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

export function egnChecksumValid(egn: string): boolean {
  if (!/^\d{10}$/.test(egn)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(egn[i]) * EGN_WEIGHTS[i];
  const check = (sum % 11) % 10;
  return check === Number(egn[9]);
}

/** Decode the date of birth encoded in an ЕГН, or null when it is not a real date. */
export function egnBirthDate(egn: string): string | null {
  if (!/^\d{10}$/.test(egn)) return null;
  const yy = Number(egn.slice(0, 2));
  let mm = Number(egn.slice(2, 4));
  const dd = Number(egn.slice(4, 6));

  let century: number;
  if (mm >= 41 && mm <= 52) { century = 2000; mm -= 40; }
  else if (mm >= 21 && mm <= 32) { century = 1800; mm -= 20; }
  else if (mm >= 1 && mm <= 12) { century = 1900; }
  else return null;

  const year = century + yy;
  const d = new Date(Date.UTC(year, mm - 1, dd));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function egnSex(egn: string): 'M' | 'F' | null {
  if (!/^\d{10}$/.test(egn)) return null;
  return Number(egn[8]) % 2 === 0 ? 'M' : 'F';
}

/** Validate an ЕГН and decode what it carries. */
export function parseEgn(value: string): EgnInfo {
  const egn = normalizeEgn(value);
  const checksum = egnChecksumValid(egn);
  const dob = egnBirthDate(egn);
  return {
    valid: checksum && dob !== null,
    checksum_valid: checksum,
    date_of_birth: dob,
    sex: egnSex(egn),
  };
}

/** Find the first 10-digit sequence in text that is a valid ЕГН. */
export function findEgnInText(text: string): string | null {
  const re = /(?<!\d)(\d{10})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? '')) !== null) {
    if (parseEgn(m[1]).valid) return m[1];
  }
  return null;
}

// ── ЛНЧ (личен номер на чужденец) — personal number of a foreigner ──

const LNCH_WEIGHTS = [21, 19, 17, 13, 11, 9, 7, 3, 1];

/** ЛНЧ checksum: Σ(digit_i × weight_i) mod 10, weights 21,19,17,13,11,9,7,3,1. */
export function lnchChecksumValid(value: string): boolean {
  const n = normalizeEgn(value);
  if (!/^\d{10}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(n[i]) * LNCH_WEIGHTS[i];
  return sum % 10 === Number(n[9]);
}

/**
 * What a 10-digit personal number printed on a Bulgarian document is: a citizen's
 * ЕГН, a foreigner's ЛНЧ (residence permits), or neither. A number can pass both
 * checksums; ЕГН wins when it also encodes a real birth date.
 */
export function classifyPersonalNumber(value: string): 'egn' | 'lnch' | 'unknown' {
  if (parseEgn(value).valid) return 'egn';
  if (lnchChecksumValid(value)) return 'lnch';
  return 'unknown';
}
