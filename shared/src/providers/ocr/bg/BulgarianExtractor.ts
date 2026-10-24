/**
 * Bulgarian document extraction.
 *
 * Turns OCR lines (text + confidence, plus position when available) from a
 * Bulgarian identity card, passport or driving licence into normalised,
 * structured fields in Cyrillic and Latin.
 *
 * Approach (no fixed pixel templates):
 *   1. Layout identification from keywords, numbered EU licence fields and MRZ shape.
 *   2. Bilingual label matching ("Фамилия/Surname", "ЕГН/Personal No", …), with the
 *      value taken from the same line (right of the label) or the following lines.
 *   3. Regex validation of each value (dates, document numbers, ЕГН).
 *   4. Bulgarian rules: ЕГН checksum and the birth date / sex it encodes,
 *      Streamlined-System transliteration for missing Latin names.
 *
 * Pure and deterministic — no I/O, no model calls.
 */

import { parseEgn, normalizeEgn, findEgnInText } from './egn.js';
import {
  transliterateBulgarian, hasCyrillic, foldLatinLookalikes, foldCyrillicLookalikes,
} from './transliteration.js';

export interface BgOcrLine {
  text: string;
  confidence: number;
  x?: number;
  y?: number;
  width?: number;
}

export type BgDocumentKind = 'id_card' | 'passport' | 'driving_licence' | 'unknown';

export interface BgLayout {
  document: BgDocumentKind;
  /** Best guess at the card generation; null when the signals don't say. */
  generation: 'id_card_2010' | 'id_card_2024' | 'passport_2010' | 'driving_licence_eu' | null;
  side: 'front' | 'back' | 'data_page' | 'unknown';
  confidence: number;
  signals: string[];
}

export interface BgExtraction {
  layout: BgLayout;
  fields: Record<string, string | string[] | boolean | null>;
  confidence_scores: Record<string, number>;
}

// ── Labels ────────────────────────────────────────────────────

// Cyrillic letters, used to stop "ИМЕ" matching inside "ПРЕЗИМЕ".
const C = 'А-ЯЁЪЬЮЯа-яёъьюя';

const LABELS = {
  surname: [new RegExp(`ФАМИЛИЯ`, 'i'), /SURNAME/i],
  given: [new RegExp(`(?<![${C}])ИМЕ(?:НА)?(?![${C}])`, 'i'), /GIVEN\s*NAMES?/i, /(?:^|\/)\s*NAME(?!\s*OF)\b/i],
  patronymic: [/ПРЕЗИМЕ/i, /FATHER['’`]?S?\s*NAME/i],
  nationality: [/ГРАЖДАНСТВО/i, /NATIONALITY/i],
  date_of_birth: [/ДАТА\s*НА\s*РАЖДАНЕ/i, /DATE\s*OF\s*BIRTH/i],
  sex: [new RegExp(`(?<![${C}])ПОЛ(?![${C}])`, 'i'), /\bSEX\b/i],
  personal_number: [/ЕГН/i, /PERSONAL\s*N[OoОо0º°]/i, /ЛИЧЕН\s*(?:№|НОМЕР)/i],
  expiration_date: [/ВАЛИДНОСТ/i, /ВАЛИДЕН\s*ДО/i, /DATE\s*OF\s*EXPIRY/i, /EXPIRY/i],
  document_number: [/(?:№|НОМЕР)\s*НА\s*ДОКУМЕНТА/i, /DOCUMENT\s*N(?:UMBER|O)/i, /ПАСПОРТ\s*№/i, /PASSPORT\s*N[OoО]/i],
  place_of_birth: [/МЯСТО\s*НА\s*РАЖДАНЕ/i, /PLACE\s*OF\s*BIRTH/i],
  address: [/ПОСТОЯНЕН\s*АДРЕС/i, /RESIDENCE/i],
  issuing_authority: [/ИЗДАДЕН[АО]?\s*ОТ/i, /AUTHORITY/i],
  issue_date: [/ДАТА\s*НА\s*ИЗДАВАНЕ/i, /DATE\s*OF\s*ISSUE/i],
  height: [/РЪСТ/i, /HEIGHT/i],
  eye_color: [/ЦВЯТ\s*НА\s*ОЧИТЕ/i, /COLOU?R\s*OF\s*EYES/i],
  type: [/^\s*ВИД\b/i, /\bTYPE\b/i],
  code: [/^\s*КОД\b/i, /\bCODE\b/i],
} as const;

type LabelKey = keyof typeof LABELS;
const ALL_LABELS: RegExp[] = Object.values(LABELS).flat();

const HEADER_NOISE = [
  /РЕПУБЛИКА\s*БЪЛГАРИЯ/i, /REPUBLIC\s*OF\s*BULGARIA/i, /REPUBLIQUE\s*DE\s*BULGARIE/i,
  /ЛИЧНА\s*КАРТА/i, /IDENTITY\s*CARD/i, /CARTE\s*D.?IDENTIT/i,
  /^\s*ПАСПОРТ\s*$/i, /^\s*PASSPORT\s*$/i, /PASSEPORT/i,
  /СВИДЕТЕЛСТВО\s*ЗА\s*УПРАВЛЕНИЕ/i, /DRIVING\s*LICEN[CS]E/i, /ЕВРОПЕЙСКИ\s*СЪЮЗ|EUROPEAN\s*UNION/i,
];

function isLabelLine(text: string): boolean {
  return ALL_LABELS.some(re => re.test(text));
}

function isNoiseLine(text: string): boolean {
  return HEADER_NOISE.some(re => re.test(text));
}

const MRZ_LINE = /^[A-Z0-9<]{28,46}$/;

function isMrzLine(text: string): boolean {
  return MRZ_LINE.test(text.replace(/\s/g, '')) && text.includes('<');
}

// ── Layout identification ─────────────────────────────────────

export function identifyBulgarianLayout(lines: BgOcrLine[]): BgLayout {
  const text = lines.map(l => l.text).join('\n');
  const mrz = lines.map(l => l.text.replace(/\s/g, '')).filter(t => isMrzLine(t));
  const signals: string[] = [];
  let document: BgDocumentKind = 'unknown';
  let confidence = 0.4;

  const td3 = mrz.some(l => l.length >= 43 && /^P[A-Z<]BGR/.test(l));
  const td1 = mrz.some(l => l.length >= 29 && l.length <= 31 && /^I[A-Z<]BGR/.test(l));
  const numberedFields = lines.filter(l => /^\s*(?:[1-9]|4[abcdабсд]|1[0-2])\s*[.,](?!\d)\s*\S/i.test(l.text)).length;

  if (td3 || /ПАСПОРТ|PASSPORT|PASSEPORT/i.test(text)) {
    document = 'passport';
    signals.push(td3 ? 'mrz_td3_bgr' : 'keyword_passport');
    confidence = td3 ? 0.95 : 0.85;
  } else if (/СВИДЕТЕЛСТВО\s*ЗА\s*УПРАВЛЕНИЕ|DRIVING\s*LICEN[CS]E/i.test(text) || numberedFields >= 4) {
    document = 'driving_licence';
    signals.push(numberedFields >= 4 ? `numbered_fields_${numberedFields}` : 'keyword_driving_licence');
    confidence = 0.85;
  } else if (td1 || /ЛИЧНА\s*КАРТА|IDENTITY\s*CARD|CARTE\s*D.?IDENTIT/i.test(text) || /ЕГН/i.test(text)) {
    document = 'id_card';
    signals.push(td1 ? 'mrz_td1_bgr' : 'keyword_id_card');
    confidence = td1 ? 0.95 : 0.85;
  }

  let side: BgLayout['side'] = 'unknown';
  const hasFrontLabels = /ФАМИЛИЯ|SURNAME/i.test(text);
  const hasBackLabels = /МЯСТО\s*НА\s*РАЖДАНЕ|PLACE\s*OF\s*BIRTH|ПОСТОЯНЕН\s*АДРЕС|RESIDENCE/i.test(text);
  if (document === 'passport') side = 'data_page';
  else if (document === 'id_card') {
    if (td1 || (hasBackLabels && !hasFrontLabels)) side = 'back';
    else if (hasFrontLabels) side = 'front';
  } else if (document === 'driving_licence') {
    side = numberedFields >= 3 ? 'front' : (/\b9\s*[.,]|\b1[0-2]\s*[.,]/.test(text) ? 'back' : 'unknown');
  }

  let generation: BgLayout['generation'] = null;
  if (document === 'id_card') {
    // The 2024 card follows Regulation (EU) 2019/1157 and adds French to the title.
    generation = /CARTE\s*D.?IDENTIT/i.test(text) ? 'id_card_2024'
      : (hasFrontLabels || td1 || hasBackLabels) ? 'id_card_2010' : null;
  } else if (document === 'passport') {
    generation = 'passport_2010';
  } else if (document === 'driving_licence') {
    generation = 'driving_licence_eu';
  }
  if (generation) signals.push(`generation_${generation}`);

  return { document, generation, side, confidence, signals };
}

// ── Value helpers ─────────────────────────────────────────────

/** Remove every label phrase and the bilingual "/" separators from a line. */
function stripLabels(text: string): string {
  let out = text;
  for (const re of ALL_LABELS) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), ' ');
  return out.replace(/^[\s\/:|.,№-]+/, '').replace(/[\s\/:|]+$/, '').replace(/\s+/g, ' ').trim();
}

interface Found { value: string; confidence: number; index: number }

/**
 * Locate a labelled value: same line to the right of the label, else the next
 * non-label lines (up to `maxLines`), stopping at the next label.
 */
function findLabelled(lines: BgOcrLine[], key: LabelKey, maxLines = 1): Found[] {
  const patterns = LABELS[key];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!patterns.some(re => re.test(line.text))) continue;

    const results: Found[] = [];
    const sameLine = stripLabels(line.text);
    if (sameLine.length > 0) results.push({ value: sameLine, confidence: line.confidence, index: i });

    for (let j = i + 1; j < lines.length && results.length < maxLines; j++) {
      const next = lines[j];
      if (isLabelLine(next.text) || isMrzLine(next.text)) break;
      if (isNoiseLine(next.text) || !next.text.trim()) continue;
      results.push({ value: next.text.trim(), confidence: next.confidence, index: j });
    }
    if (results.length > 0) return results;
  }
  return [];
}

const DATE_RE = /(\d{1,2})\s*[.\/\-]\s*(\d{1,2})\s*[.\/\-]\s*(\d{4})/;

/** Parse a Bulgarian DD.MM.YYYY date to YYYY-MM-DD. */
export function parseBgDate(text: string): string | null {
  const m = foldLatinLookalikes(text).replace(/[OoОо]/g, '0').match(DATE_RE);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Bulgarian document numbers: 9 digits, or 2 letters + 7 digits on newer cards. */
const DOC_NUMBER_RE = /(?<![A-Z0-9])([A-Z]{2}\d{7}|\d{9})(?![A-Z0-9])/;

export function parseBgDocumentNumber(text: string): string | null {
  const folded = foldLatinLookalikes(text.replace(/(?<=[\dA-ZА-Я])\s+(?=\d)/gi, '')).toUpperCase();
  const m = folded.match(DOC_NUMBER_RE);
  return m ? m[1] : null;
}

function parseSex(text: string): 'M' | 'F' | null {
  const t = text.toUpperCase();
  if (/(?:^|[\s\/])(?:Ж|F)(?:$|[\s\/])/.test(t)) return 'F';
  if (/(?:^|[\s\/])(?:М|M)(?:$|[\s\/])/.test(t)) return 'M';
  return null;
}

/** Split "СОФИЯ/SOFIA" into its Cyrillic and Latin halves. */
function splitBilingual(value: string): { cyrillic: string | null; latin: string | null } {
  const parts = value.split('/').map(p => p.trim()).filter(Boolean);
  let cyrillic: string | null = null;
  let latin: string | null = null;
  for (const p of parts) {
    if (hasCyrillic(p) && !cyrillic) cyrillic = p;
    else if (/[A-Za-z]/.test(p) && !hasCyrillic(p) && !latin) latin = p;
  }
  return { cyrillic, latin };
}

/** Clean a name token: keep letters, spaces and hyphens; fold stray look-alikes. */
function cleanName(value: string): string {
  const cleaned = value.replace(/[^A-Za-zЀ-ӿ\s'\-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return cleaned.split(' ').map(t => (hasCyrillic(t) ? foldCyrillicLookalikes(t) : t)).join(' ');
}

/** From the value lines after a name label, take the Cyrillic and the Latin form. */
function namePair(found: Found[]): { cyrillic: string | null; latin: string | null; confidence: number } {
  let cyrillic: string | null = null;
  let latin: string | null = null;
  let confidence = 0;
  for (const f of found) {
    for (const part of f.value.split('/')) {
      const name = cleanName(part);
      if (name.length < 2 || isLabelLine(name) || isNoiseLine(name)) continue;
      if (hasCyrillic(name)) { if (!cyrillic) { cyrillic = name; confidence = Math.max(confidence, f.confidence); } }
      else if (!latin) { latin = name; confidence = Math.max(confidence, f.confidence); }
    }
  }
  return { cyrillic, latin, confidence };
}

// ── EU numbered fields (driving licence) ──────────────────────

function numberedFields(lines: BgOcrLine[]): Map<string, Found[]> {
  const map = new Map<string, Found[]>();
  let current: string | null = null;
  // "4a. 10.03.2020 4c. МВР" — two numbered fields printed on one row
  const split = lines.flatMap(l => l.text
    .split(/\s+(?=4\s*[abcdабсд]\s*[.,](?!\d))/i)
    .map(text => ({ ...l, text })));
  split.forEach((line, index) => {
    const m = line.text.match(/^\s*(4\s*[abcdабсд]|1[0-4]|[1-9])\s*[.,](?!\d)\s*(.*)$/i);
    if (m) {
      current = m[1].replace(/\s/g, '').toLowerCase()
        .replace('а', 'a').replace('б', 'b').replace('с', 'c').replace('д', 'd');
      const rest = m[2].trim();
      map.set(current, rest ? [{ value: rest, confidence: line.confidence, index }] : []);
    } else if (current && map.get(current)!.length < 2 && line.text.trim() && !isNoiseLine(line.text)) {
      map.get(current)!.push({ value: line.text.trim(), confidence: line.confidence, index });
    }
  });
  return map;
}

const LICENCE_CATEGORIES = ['AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE', 'TTB', 'TKT', 'TM'];

// ── Main entry point ──────────────────────────────────────────

export function extractBulgarianDocument(rawLines: BgOcrLine[], documentTypeHint?: string): BgExtraction {
  const lines = rawLines
    .map(l => ({ ...l, text: foldLatinLookalikes(l.text ?? '').trim() }))
    .filter(l => l.text.length > 0);

  const layout = identifyBulgarianLayout(lines);
  if (layout.document === 'unknown' && documentTypeHint) {
    const hinted: Record<string, BgDocumentKind> = { national_id: 'id_card', passport: 'passport', drivers_license: 'driving_licence' };
    if (hinted[documentTypeHint]) { layout.document = hinted[documentTypeHint]; layout.signals.push('caller_hint'); }
  }

  const fields: BgExtraction['fields'] = {};
  const conf: Record<string, number> = {};
  const set = (key: string, value: string | string[] | boolean | null, c: number) => {
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    fields[key] = value;
    conf[key] = c;
  };

  if (layout.document === 'driving_licence') {
    const nf = numberedFields(lines);
    const surname = namePair(nf.get('1') ?? []);
    const given = namePair(nf.get('2') ?? []);
    set('surname_cyrillic', surname.cyrillic, surname.confidence);
    set('surname_latin', surname.latin, surname.confidence);
    // Field 2 carries given name + patronymic ("ИВАН ГЕОРГИЕВ").
    if (given.cyrillic) {
      const [first, ...rest] = given.cyrillic.split(' ');
      set('given_name_cyrillic', first, given.confidence);
      set('patronymic_cyrillic', rest.join(' ') || null, given.confidence);
    }
    if (given.latin) {
      const [first, ...rest] = given.latin.split(' ');
      set('given_name_latin', first, given.confidence);
      set('patronymic_latin', rest.join(' ') || null, given.confidence);
    }
    const f3 = nf.get('3')?.[0];
    if (f3) {
      set('date_of_birth', parseBgDate(f3.value), f3.confidence);
      const place = f3.value.replace(DATE_RE, '').replace(/^[\s,]+/, '').trim();
      if (place) {
        const p = splitBilingual(place);
        set('place_of_birth', p.cyrillic ?? p.latin, f3.confidence);
        set('place_of_birth_latin', p.latin ?? (p.cyrillic ? transliterateBulgarian(p.cyrillic) : null), f3.confidence);
      }
    }
    const f4a = nf.get('4a')?.[0]; if (f4a) set('issue_date', parseBgDate(f4a.value), f4a.confidence);
    const f4b = nf.get('4b')?.[0]; if (f4b) set('expiration_date', parseBgDate(f4b.value), f4b.confidence);
    const f4c = nf.get('4c')?.[0]; if (f4c) set('issuing_authority', f4c.value, f4c.confidence);
    const f4d = nf.get('4d')?.[0];
    if (f4d) { const egn = normalizeEgn(f4d.value); if (egn.length === 10) set('personal_number', egn, f4d.confidence); }
    const f5 = nf.get('5')?.[0]; if (f5) set('document_number', parseBgDocumentNumber(f5.value), f5.confidence);
    const f8 = nf.get('8'); if (f8?.length) set('address', f8.map(f => f.value).join(', '), f8[0].confidence);
    const f9 = nf.get('9');
    if (f9?.length) {
      const tokens = f9.map(f => f.value).join(' ').toUpperCase().split(/[\s,;\/]+/);
      const cats = LICENCE_CATEGORIES.filter(c => tokens.includes(c));
      set('licence_categories', cats, f9[0].confidence);
    }
  } else {
    // ID card / passport: bilingual labels
    const surname = namePair(findLabelled(lines, 'surname', 2));
    const given = namePair(findLabelled(lines, 'given', 2));
    const patronymic = namePair(findLabelled(lines, 'patronymic', 2));
    set('surname_cyrillic', surname.cyrillic, surname.confidence);
    set('surname_latin', surname.latin, surname.confidence);
    set('given_name_cyrillic', given.cyrillic, given.confidence);
    set('given_name_latin', given.latin, given.confidence);
    set('patronymic_cyrillic', patronymic.cyrillic, patronymic.confidence);
    set('patronymic_latin', patronymic.latin, patronymic.confidence);

    for (const [key, labelKey] of [['date_of_birth', 'date_of_birth'], ['expiration_date', 'expiration_date'], ['issue_date', 'issue_date']] as const) {
      const f = findLabelled(lines, labelKey, 1)[0];
      if (f) set(key, parseBgDate(f.value), f.confidence);
    }

    const sexF = findLabelled(lines, 'sex', 1)[0];
    if (sexF) set('sex', parseSex(sexF.value), sexF.confidence);

    const natF = findLabelled(lines, 'nationality', 1)[0];
    if (natF) {
      const n = splitBilingual(natF.value);
      const code = natF.value.toUpperCase().match(/\b([A-Z]{3})\b/)?.[1];
      set('nationality', code ?? n.latin ?? (n.cyrillic ? transliterateBulgarian(n.cyrillic) : null), natF.confidence);
      set('nationality_cyrillic', n.cyrillic, natF.confidence);
    }

    const egnF = findLabelled(lines, 'personal_number', 1)[0];
    if (egnF) {
      const egn = normalizeEgn(egnF.value);
      if (egn.length === 10) set('personal_number', egn, egnF.confidence);
    }

    const docF = findLabelled(lines, 'document_number', 1)[0];
    if (docF) set('document_number', parseBgDocumentNumber(docF.value), docF.confidence);

    const pobF = findLabelled(lines, 'place_of_birth', 1)[0];
    if (pobF) {
      const p = splitBilingual(pobF.value);
      set('place_of_birth', p.cyrillic ?? p.latin, pobF.confidence);
      set('place_of_birth_latin', p.latin ?? (p.cyrillic ? transliterateBulgarian(p.cyrillic) : null), pobF.confidence);
    }

    const addrF = findLabelled(lines, 'address', 3);
    if (addrF.length) set('address', addrF.map(f => f.value).join(', '), addrF[0].confidence);

    const authF = findLabelled(lines, 'issuing_authority', 1)[0];
    if (authF) set('issuing_authority', authF.value, authF.confidence);

    const hF = findLabelled(lines, 'height', 1)[0];
    if (hF) set('height', hF.value.match(/\d{3}/)?.[0] ?? null, hF.confidence);

    const eyeF = findLabelled(lines, 'eye_color', 1)[0];
    if (eyeF) {
      const e = splitBilingual(eyeF.value);
      set('eye_color', e.latin ?? e.cyrillic, eyeF.confidence);
    }
  }

  // Fallbacks over the whole text when a label was not read
  const allText = lines.filter(l => !isMrzLine(l.text)).map(l => l.text).join('\n');
  if (!fields.personal_number) {
    const egn = findEgnInText(allText);
    if (egn) set('personal_number', egn, 0.7);
  }
  if (!fields.document_number && layout.side !== 'back') {
    for (const l of lines) {
      if (isMrzLine(l.text)) continue;
      const num = parseBgDocumentNumber(l.text);
      if (num && num !== fields.personal_number) { set('document_number', num, l.confidence * 0.8); break; }
    }
  }

  // Latin names: printed form first, transliteration as fallback
  for (const part of ['surname', 'given_name', 'patronymic']) {
    const cyr = fields[`${part}_cyrillic`] as string | undefined;
    if (cyr && !fields[`${part}_latin`]) {
      set(`${part}_latin`, transliterateBulgarian(cyr), (conf[`${part}_cyrillic`] ?? 0.5) * 0.9);
      fields[`${part}_latin_source`] = 'transliterated';
    }
  }

  // ЕГН validation and cross-checks
  if (typeof fields.personal_number === 'string') {
    const info = parseEgn(fields.personal_number);
    fields.personal_number_valid = info.valid;
    if (!fields.date_of_birth && info.valid && info.date_of_birth) set('date_of_birth', info.date_of_birth, 0.9);
    if (!fields.sex && info.valid && info.sex) set('sex', info.sex, 0.9);
    if (info.valid && fields.date_of_birth) fields.personal_number_matches_dob = info.date_of_birth === fields.date_of_birth;
    if (info.valid && fields.sex) fields.personal_number_matches_sex = info.sex === fields.sex;
  }

  return { layout, fields, confidence_scores: conf };
}

/**
 * Map a Bulgarian extraction onto the generic OCRData shape used by the rest of
 * the pipeline (Latin full name, document number, dates…), keeping every
 * Bulgarian-specific field alongside.
 */
export function applyBulgarianExtraction(ocrData: Record<string, any>, extraction: BgExtraction): void {
  const f = extraction.fields;
  ocrData.confidence_scores = ocrData.confidence_scores ?? {};

  for (const [key, value] of Object.entries(f)) {
    ocrData[key] = value;
    if (extraction.confidence_scores[key] !== undefined) {
      ocrData.confidence_scores[key] = extraction.confidence_scores[key];
    }
  }

  const latinName = [f.given_name_latin, f.patronymic_latin, f.surname_latin].filter(Boolean).join(' ');
  const cyrName = [f.given_name_cyrillic, f.patronymic_cyrillic, f.surname_cyrillic].filter(Boolean).join(' ');
  if (latinName) {
    ocrData.name = latinName;
    ocrData.confidence_scores.name = Math.max(
      extraction.confidence_scores.surname_latin ?? 0,
      extraction.confidence_scores.given_name_latin ?? 0,
    );
  }
  if (cyrName) ocrData.name_cyrillic = cyrName;
  if (f.given_name_latin) ocrData.first_name = f.given_name_latin;
  if (f.surname_latin) ocrData.last_name = f.surname_latin;
  if (f.patronymic_latin) ocrData.middle_name = f.patronymic_latin;

  const kindToType: Record<BgDocumentKind, string | undefined> = {
    id_card: 'national_id', passport: 'passport', driving_licence: 'drivers_license', unknown: undefined,
  };
  const docType = kindToType[extraction.layout.document];
  if (docType) {
    ocrData.detected_document_type = docType;
    ocrData.classification_confidence = extraction.layout.confidence;
  }
  ocrData.bg_layout = extraction.layout;
  ocrData.issuing_country = 'BG';
}

// ── MRZ cross-check ───────────────────────────────────────────

export interface BgMrzFields {
  document_number?: string | null;
  date_of_birth?: string | null;
  expiry_date?: string | null;
  personal_number?: string | null;
  sex?: string | null;
  last_name?: string | null;
}

/**
 * Compare the visually read fields with the MRZ (checksum-protected) and record
 * the outcome per field under `mrz_cross_check` (true / false; absent when one side
 * is missing). Fills the ЕГН from the MRZ when the visual read missed it.
 * Never changes a visually read value — the decision stays with the caller.
 */
export function crossCheckBulgarianMrz(ocrData: Record<string, any>, mrz: BgMrzFields): void {
  const checks: Record<string, boolean> = {};
  const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const mrzEgn = mrz.personal_number ? normalizeEgn(mrz.personal_number) : '';
  if (mrzEgn.length === 10 && !ocrData.personal_number) {
    ocrData.personal_number = mrzEgn;
    ocrData.personal_number_valid = parseEgn(mrzEgn).valid;
    ocrData.confidence_scores = ocrData.confidence_scores ?? {};
    ocrData.confidence_scores.personal_number = 0.95;
  }

  const pairs: Array<[string, unknown, unknown]> = [
    ['document_number', ocrData.document_number, mrz.document_number],
    ['date_of_birth', ocrData.date_of_birth, mrz.date_of_birth],
    ['expiration_date', ocrData.expiration_date, mrz.expiry_date],
    ['personal_number', ocrData.personal_number, mrzEgn || null],
    ['sex', ocrData.sex, mrz.sex === 'male' ? 'M' : mrz.sex === 'female' ? 'F' : mrz.sex],
    ['surname', ocrData.surname_latin, mrz.last_name],
  ];
  for (const [field, visual, machine] of pairs) {
    if (!visual || !machine) continue;
    checks[field] = norm(visual) === norm(machine);
  }
  if (Object.keys(checks).length > 0) ocrData.mrz_cross_check = checks;
}
