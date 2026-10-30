/**
 * Per-field confirmation for Bulgarian ID cards: which extracted values are backed
 * by independent sources on the card, and which need a human.
 *
 * Sources (all on the card, read separately):
 *   - the front's printed fields (Cyrillic and Latin)
 *   - the back: the surname printed again, and the MRZ (a field counts only when
 *     its own check digit passed)
 *   - the ЕГН, which encodes the date of birth and the sex
 *   - the official transliteration, which ties each Cyrillic name to its Latin form
 *
 * Status per field:
 *   confirmed      two or more sources agree and none disagrees
 *   single_source  only one source could be read
 *   conflict       sources disagree (which one is listed)
 *   invalid        the only reading fails its own check (e.g. the ЕГН checksum)
 *   missing        nothing could be read
 *
 * A critical field that is not confirmed goes to manual review: the system never
 * reports a document as verified on a value it could not cross-check. Agreement
 * between sources shows the card was read consistently; it is not evidence that
 * the card is genuine. Pure and deterministic.
 */

import { transliterateBulgarian } from './transliteration.js';
import { parseEgn, egnBirthDate, egnSex, normalizeEgn } from './egn.js';

export type BgFieldStatus = 'confirmed' | 'single_source' | 'conflict' | 'invalid' | 'missing';

export interface BgFieldCheck {
  value: string | null;
  status: BgFieldStatus;
  /** Every source that was read, normalized for comparison */
  sources: Record<string, string>;
  /** Sources that disagree with the value (for status conflict) */
  disagreeing?: string[];
  reason?: string;
}

export interface BgConfirmation {
  fields: Record<string, BgFieldCheck>;
  /** Critical fields that are not confirmed, with the reason */
  review_fields: Array<{ field: string; status: BgFieldStatus; reason: string }>;
  /** True when every critical field is confirmed */
  all_critical_confirmed: boolean;
}

export interface BgMrzInput {
  fields?: Record<string, string | null | undefined>;
  check_digits?: Record<string, boolean>;
  raw_lines?: string[];
}

export const BG_CRITICAL_FIELDS = ['surname', 'given_name', 'document_number', 'date_of_birth', 'expiry_date', 'personal_number'] as const;

const latinKey = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const digitKey = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** Document numbers compare with O read as 0 in the digit part (2024: two letters + digits) */
function docKey(s: unknown): string {
  const k = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const letters = /^[A-Z]{2}(?=[0-9O]{7}$)/.exec(k)?.[0] ?? '';
  return letters + k.slice(letters.length).replace(/O/g, '0');
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Status from named source readings. `agrees(a, b)` compares two readings; the
 * value reported is the first source's reading among the agreeing majority.
 */
function decide(field: string, readings: Record<string, string | null>, agrees: (a: string, b: string) => boolean,
  display: (source: string, reading: string) => string): BgFieldCheck {
  const sources = Object.fromEntries(Object.entries(readings).filter(([, v]) => v)) as Record<string, string>;
  const names = Object.keys(sources);
  if (names.length === 0) return { value: null, status: 'missing', sources, reason: `${field} could not be read` };
  if (names.length === 1) {
    return { value: display(names[0], sources[names[0]]), status: 'single_source', sources, reason: `${field} read only from ${names[0]}` };
  }
  // Largest group of mutually agreeing sources; ties go to the earlier source
  let best: string[] = [];
  for (const a of names) {
    const group = names.filter(b => agrees(sources[a], sources[b]));
    if (group.length > best.length) best = group;
  }
  const value = display(best[0], sources[best[0]]);
  const disagreeing = names.filter(n => !best.includes(n));
  if (disagreeing.length === 0) return { value, status: 'confirmed', sources };
  return {
    value, status: 'conflict', sources, disagreeing,
    reason: `${field}: ${disagreeing.join(', ')} ${disagreeing.length === 1 ? 'differs' : 'differ'} from ${best.join(', ')}`,
  };
}

/** MRZ name parts: surname; given names = first token, father's name = the rest (Bulgarian order). */
function mrzNames(mrz: BgMrzInput) {
  const f = mrz.fields ?? {};
  // A trailing one-letter token is filler noise ("GEORGIEVA<K<<"), not a name
  const given = (str(f.first_name) ?? '').replace(/(?:\s+\S)+\s*$/, '').split(/\s+/).filter(Boolean);
  const line3 = mrz.raw_lines?.[2] ?? '';
  return {
    surname: str(f.last_name),
    given_name: given[0] ?? null,
    patronymic: given.slice(1).join(' ') || null,
    // TD1 names are cut at 30 characters; a full line may end mid-name
    truncated: line3.length === 30 && !line3.endsWith('<'),
  };
}

export function confirmBulgarianFields(
  front: Record<string, unknown>,
  back: Record<string, unknown> = {},
  mrz: BgMrzInput | null = null,
): BgConfirmation {
  const checks = mrz?.check_digits;
  // An MRZ field counts only when its own check digit passed (no check digits reported: trust the parse)
  const mrzField = (key: string, check: string) =>
    mrz && (!checks || checks[check] !== false) ? str(mrz.fields?.[key]) : null;
  const names = mrz ? mrzNames(mrz) : { surname: null, given_name: null, patronymic: null, truncated: false };

  const fields: Record<string, BgFieldCheck> = {};

  // ── Names: Cyrillic (transliterated), printed Latin, MRZ, back of the card ──
  for (const part of ['surname', 'given_name', 'patronymic'] as const) {
    const cyr = str(front[`${part}_cyrillic`]);
    const readings: Record<string, string | null> = {
      front_cyrillic: cyr ? transliterateBulgarian(cyr) : null,
      front_latin: front[`${part}_latin_source`] === 'transliterated' ? null : str(front[`${part}_latin`]),
      mrz: names[part],
    };
    if (part === 'surname') {
      const backCyr = str(back.surname_cyrillic);
      readings.back_cyrillic = backCyr ? transliterateBulgarian(backCyr) : null;
    }
    const check = decide(part, readings,
      (a, b) => {
        const ka = latinKey(a), kb = latinKey(b);
        if (ka === kb) return true;
        // A truncated MRZ name is a prefix of the printed one
        return names.truncated && (ka.startsWith(kb) || kb.startsWith(ka)) && Math.min(ka.length, kb.length) >= 3;
      },
      (source, reading) => (source === 'front_cyrillic' ? cyr! : source === 'back_cyrillic' ? str(back.surname_cyrillic)! : reading));
    fields[part] = check;
  }

  // ── Document number: front vs MRZ ──
  fields.document_number = decide('document_number', {
    front: str(front.document_number), mrz: mrzField('document_number', 'document_number'),
  }, (a, b) => docKey(a) === docKey(b), (_s, r) => r);

  // ── ЕГН: front vs MRZ optional data; its checksum must hold ──
  const frontEgn = str(front.personal_number) ? normalizeEgn(String(front.personal_number)) : null;
  const mrzEgn = mrz && (!checks || checks.composite !== false) && str(mrz.fields?.personal_number)
    ? normalizeEgn(String(mrz.fields!.personal_number)) : null;
  const egn = decide('personal_number', { front: frontEgn, mrz: mrzEgn }, (a, b) => a === b, (_s, r) => r);
  if (egn.value && !parseEgn(egn.value).checksum_valid) {
    egn.status = 'invalid';
    egn.reason = 'personal_number fails the ЕГН checksum';
  }
  fields.personal_number = egn;
  const egnValid = egn.value && egn.status !== 'invalid' ? egn.value : null;

  // ── Date of birth: front, MRZ, and the date inside a valid ЕГН ──
  fields.date_of_birth = decide('date_of_birth', {
    front: str(front.date_of_birth), mrz: mrzField('date_of_birth', 'date_of_birth'),
    personal_number: egnValid ? egnBirthDate(egnValid) : null,
  }, (a, b) => digitKey(a) === digitKey(b), (_s, r) => r);

  // ── Expiry: front vs MRZ ──
  fields.expiry_date = decide('expiry_date', {
    front: str(front.expiration_date ?? front.expiry_date), mrz: mrzField('expiry_date', 'expiry_date'),
  }, (a, b) => digitKey(a) === digitKey(b), (_s, r) => r);

  // ── Sex: front, MRZ, ЕГН 9th digit ──
  const mrzSex = str(mrz?.fields?.sex);
  fields.sex = decide('sex', {
    front: str(front.sex),
    mrz: mrzSex ? (/^m/i.test(mrzSex) ? 'M' : /^f/i.test(mrzSex) ? 'F' : null) : null,
    personal_number: egnValid ? egnSex(egnValid) : null,
  }, (a, b) => a === b, (_s, r) => r);

  // ── Nationality: front vs MRZ ──
  fields.nationality = decide('nationality', {
    front: str(front.nationality), mrz: str(mrz?.fields?.nationality),
  }, (a, b) => latinKey(a) === latinKey(b), (_s, r) => r);

  const review_fields = BG_CRITICAL_FIELDS
    .filter(f => fields[f].status !== 'confirmed')
    .map(f => ({ field: f, status: fields[f].status, reason: fields[f].reason ?? fields[f].status }));

  return { fields, review_fields, all_critical_confirmed: review_fields.length === 0 };
}
