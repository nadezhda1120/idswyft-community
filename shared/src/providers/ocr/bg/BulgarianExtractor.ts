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

import { parseEgn, normalizeEgn, findEgnInText, classifyPersonalNumber } from './egn.js';
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
  fields: Record<string, string | string[] | boolean | null | LicenceCategoryRow[]>;
  confidence_scores: Record<string, number>;
}

// ── Labels ────────────────────────────────────────────────────

/**
 * Letters the OCR confuses across scripts and with italic forms, e.g. ЕГН → "ETH",
 * Дата → "Даmа", Валидност → "Baлugнocm", Surname → "Sигпате". A label is matched
 * with every letter widened to its class, so a misread label is still recognised
 * (and stripped from the value instead of ending up inside a name).
 */
const LOOKALIKES: Record<string, string> = {
  А: 'Aa', Б: '6', В: 'Bb', Г: 'rT', Д: 'gD', Е: 'Ee', З: '3', И: 'uU', К: 'Kk', Л: 'n',
  М: 'Mm', Н: 'Hh', О: 'Oo0', П: 'nP', Р: 'Pp', С: 'Cc', Т: 'Tmr', У: 'Yy', Х: 'Xx', Ъ: 'b', Ь: 'b',
  A: 'Аа', B: 'Вв', C: 'Сс', D: 'Дд', E: 'Ее', H: 'Нн', I: 'Іі1l', K: 'Кк', M: 'Ммт', N: 'ПпНнл',
  O: 'Оо0', P: 'Рр', R: 'гРр', S: 'Сс', T: 'Тт', U: 'Ии', X: 'Хх', Y: 'Уу',
};

/** Regex source for a label word with every letter widened to its look-alikes. */
function fz(word: string): string {
  let out = '';
  for (const ch of word) {
    if (ch === ' ') { out += '\\s*'; continue; }
    const extra = LOOKALIKES[ch.toUpperCase()];
    if (!extra && !/\p{L}/u.test(ch)) { out += ch.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); continue; }
    out += `[${ch.toUpperCase()}${ch.toLowerCase()}${extra ?? ''}]`;
  }
  return out;
}

/** Whole-word label (short labels such as ЕГН, ПОЛ, ИМЕ must not match inside words). */
const word = (src: string) => `(?<!\\p{L})(?:${src})(?!\\p{L})`;

interface Label { re: RegExp; cyrillic: boolean }
const cyr = (src: string): Label => ({ re: new RegExp(src, 'iu'), cyrillic: true });
const lat = (src: string): Label => ({ re: new RegExp(src, 'iu'), cyrillic: false });

const LABELS = {
  // Passports add French: Nom, Prénoms, Nationalité, Date de naissance, …
  surname: [cyr(fz('ФАМИЛИЯ')), lat(fz('SURNAME')), lat(word(fz('NOM')))],
  given: [
    cyr(word(fz('ИМЕ') + `(?:${fz('НА')})?`)),
    lat(fz('GIVEN NAME') + 'S?'),
    lat(word(`${fz('PR')}[ÉEЕé]${fz('NOMS')}?`)),
    lat(word(`(?<!${fz('FATHER')}['’\`]?S?\\s{0,3})${fz('NAME')}`)),
  ],
  patronymic: [cyr(fz('ПРЕЗИМЕ')), lat(`${fz('FATHER')}['’\`]?S?\\s*${fz('NAME')}`)],
  nationality: [cyr(fz('ГРАЖДАНСТВО')), lat(fz('NATIO') + '\\p{L}*')],
  date_of_birth: [cyr(fz('ДАТА НА РАЖДАНЕ')), lat(fz('DATE OF BIRTH')), lat(fz('DATE DE NAISSANCE'))],
  sex: [cyr(word(fz('ПОЛ'))), lat(word(fz('SEX') + 'E?'))],
  personal_number: [
    cyr(word(fz('ЕГН'))),
    lat(`${fz('PERSONAL')}\\s*[NnПп][OoОо0º°]\\.?`),
    lat(`[NnПп][OoОо0º°]\\.?\\s*${fz('PERSONNEL')}`),
    cyr(`${fz('ЛИЧЕН')}\\s*(?:№|${fz('НОМЕР')})`),
  ],
  expiration_date: [
    cyr(fz('ВАЛИДНОСТ')), cyr(fz('ВАЛИДЕН ДО')), lat(fz('DATE OF EXPIRY')), lat(fz('EXPIRY')),
    lat(`${fz('DATE D')}['’]?\\s*${fz('EXPIRATION')}`),
  ],
  document_number: [
    cyr(`(?:№|${fz('НОМЕР')})\\s*${fz('НА ДОКУМЕНТА')}`),
    lat(`${fz('DOCUMENT')}(?:\\s*\\p{L}+)?`),
    cyr(`${fz('ПАСПОРТ')}\\s*№`),
    lat(`${fz('PASSPORT')}\\s*N[OoО0º°]\\.?`),
    lat(`${fz('PASSEPORT')}\\s*N[OoО0º°]\\.?`),
  ],
  // The last word of "Място на раждане" is often garbled ("рааие"), so it is optional.
  place_of_birth: [cyr(`${fz('МЯСТО НА')}(?:\\s*\\p{L}+)?`), lat(fz('PLACE OF BIRTH')), lat(fz('LIEU DE NAISSANCE'))],
  address: [cyr(`${fz('ПОСТОЯНЕН')}(?:\\s*${fz('АДРЕС')})?`), lat(fz('RESIDENCE')), lat(fz('ADDRESS'))],
  issuing_authority: [cyr(`${fz('ИЗДАДЕН')}[АаОо]?\\s*${fz('ОТ')}`), lat(fz('AUTHORITY')), lat(`${fz('AUTORIT')}[ÉEЕé]`)],
  issue_date: [cyr(fz('ДАТА НА ИЗДАВАНЕ')), lat(fz('DATE OF ISSUE')), lat(`${fz('DATE DE D')}[ÉEЕé]${fz('LIVRANCE')}`)],
  height: [cyr(fz('РЪСТ')), lat(fz('HEIGH') + '\\p{L}*')],
  eye_color: [
    cyr(`(?:${fz('ЦВЯТ')}\\s*${fz('НА')}\\s*)?${fz('ОЧИТЕ')}`),
    lat('COLOU?R\\s*OF\\s*EYES'),
    lat(fz('OF EYES')),
  ],
  type: [cyr('^\\s*(?:ВИД|ТИП)(?!\\p{L})'), lat('\\bTYPE\\b')],
  code: [cyr('^\\s*КОД(?!\\p{L})'), lat('\\bCODE\\b')],
} satisfies Record<string, Label[]>;

type LabelKey = keyof typeof LABELS;
const LABEL_ENTRIES: Array<{ key: LabelKey; label: Label; global: RegExp }> = (Object.keys(LABELS) as LabelKey[])
  .flatMap(key => LABELS[key].map((label: Label) => ({ key, label, global: new RegExp(label.re.source, 'giu') })));

const HEADER_NOISE = [
  /РЕПУБЛИКА\s*БЪЛГАРИЯ/i, /REPUBLIC\s*OF\s*BULGARIA/i, /REPUBLIQUE\s*DE\s*BULGARIE/i,
  /ЛИЧНА\s*КАРТА/i, /IDENTITY\s*CARD/i, /CARTE\s*D.?IDENTIT/i,
  /^\s*ПАСПОРТ\s*$/i, /^\s*PASSPORT\s*$/i, /PASSEPORT/i,
  /СВИДЕТЕЛСТВО\s*ЗА\s*УПРАВЛЕНИЕ/i, /DRIVING\s*LICEN[CS]E/i, /ЕВРОПЕЙСКИ\s*СЪЮЗ|EUROPEAN\s*UNION/i,
  new RegExp(fz('ПОДПИС'), 'iu'), new RegExp(fz('SIGNATURE'), 'iu'),
];

interface Span { start: number; end: number; key: LabelKey }

/**
 * Every label occurrence in a line, overlaps resolved (earliest, then longest wins).
 * A Cyrillic label glued to a capitalised word ("ФамилияСаи", "Издаден отАитае.")
 * is extended over that word: it is the misread second-language label.
 */
function labelSpans(text: string): Span[] {
  const raw: Array<Span & { cyrillic: boolean }> = [];
  for (const { key, label, global } of LABEL_ENTRIES) {
    global.lastIndex = 0;
    for (const m of text.matchAll(global)) {
      if (m[0].length === 0) continue;
      raw.push({ start: m.index!, end: m.index! + m[0].length, key, cyrillic: label.cyrillic });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: Array<Span & { cyrillic: boolean }> = [];
  for (const s of raw) {
    if (spans.length && s.start < spans[spans.length - 1].end) continue;
    spans.push({ ...s });
  }
  spans.forEach((s, i) => {
    const nextStart = spans[i + 1]?.start ?? Infinity;
    if (!s.cyrillic || nextStart === s.end) return;
    if (!/\p{Ll}/u.test(text[s.end - 1] ?? '') || !/\p{Lu}/u.test(text[s.end] ?? '')) return;
    let e = s.end;
    while (e < text.length && e < nextStart && !/[\s\/]/.test(text[e])) e++;
    s.end = e;
  });
  return spans.map(({ start, end, key }) => ({ start, end, key }));
}

function isLabelLine(text: string): boolean {
  return labelSpans(text).length > 0;
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
  // Licence back: rows such as "B 10.03.2020 10.03.2030"
  const categoryRows = licenceCategoryRows(lines).length;
  const numberedFields = lines.filter(l => /^\s*(?:[1-9]|4[abcdабсд]|1[0-2])\s*[.,](?!\d)\s*\S/i.test(l.text)).length;

  if (td3 || /ПАСПОРТ|PASSPORT|PASSEPORT/i.test(text)) {
    document = 'passport';
    signals.push(td3 ? 'mrz_td3_bgr' : 'keyword_passport');
    confidence = td3 ? 0.95 : 0.85;
  } else if (/СВИДЕТЕЛСТВО\s*ЗА\s*УПРАВЛЕНИЕ|DRIVING\s*LICEN[CS]E/i.test(text) || numberedFields >= 4 || categoryRows >= 2) {
    document = 'driving_licence';
    signals.push(numberedFields >= 4 ? `numbered_fields_${numberedFields}`
      : categoryRows >= 2 ? `category_rows_${categoryRows}` : 'keyword_driving_licence');
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
    side = categoryRows >= 2 ? 'back' : numberedFields >= 3 ? 'front'
      : (/\b9\s*[.,]|\b1[0-2]\s*[.,]/.test(text) ? 'back' : 'unknown');
  }

  let generation: BgLayout['generation'] = null;
  if (document === 'id_card') {
    // The 2024 card follows Regulation (EU) 2019/1157 and adds French to the title.
    // 2024 cards also switched to "AA1234567" document numbers (2010 cards: 9 digits).
    const td1Line1 = mrz.find(l => /^I[A-Z<]BGR/.test(l));
    const letterNumber = td1Line1 ? /^[A-Z]{2}/.test(td1Line1.slice(5, 7))
      : lines.some(l => !isMrzLine(l.text) && /^[A-Z]{2}\d/.test(parseBgDocumentNumber(l.text) ?? ''));
    if (letterNumber) signals.push('document_number_letters');
    generation = /CARTE\s*D.?IDENTIT/i.test(text) || letterNumber ? 'id_card_2024'
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
  let out = '';
  let pos = 0;
  for (const s of labelSpans(text)) { out += text.slice(pos, s.start) + ' '; pos = s.end; }
  out += text.slice(pos);
  return out.replace(/^[\s\/:|.,№'-]+/, '').replace(/[\s\/:|]+$/, '').replace(/\s+/g, ' ').trim();
}

/** An OCR line, or one labelled segment of it; `row` is the index of the original line. */
interface Segment extends BgOcrLine { row: number }

/**
 * Split each line at its labels. The detector often merges a whole block of the
 * card into one line ("Surname IVANOVA Име МАРИЦА Name MARITSA Презиме …"), so
 * every label starts a new segment. Bilingual pairs of the same field
 * ("Фамилия/Surname") stay together.
 */
function segmentLines(lines: BgOcrLine[]): Segment[] {
  const out: Segment[] = [];
  lines.forEach((line, row) => {
    const spans = labelSpans(line.text);
    const cuts: number[] = [];
    spans.forEach((s, i) => {
      const prev = spans[i - 1];
      const gap = prev ? line.text.slice(prev.end, s.start) : '';
      if (prev && prev.key === s.key && /^[\s\/:.,|]*$/.test(gap)) return;
      cuts.push(s.start);
    });
    if (cuts[0] !== 0) cuts.unshift(0);
    cuts.forEach((start, i) => {
      const text = line.text.slice(start, cuts[i + 1] ?? line.text.length).trim();
      if (text) out.push({ ...line, text, row });
    });
  });
  return out;
}

interface Found { value: string; confidence: number; index: number }

/**
 * Locate a labelled value: same segment to the right of the label, else the next
 * non-label lines (up to `maxLines`), stopping at the next label. Empty labels
 * from the same row are skipped, so a header row ("Пол/Sex Гражданство/Nationality")
 * above a value row works. With `all`, values from every occurrence are returned.
 */
function findLabelled(lines: Segment[], key: LabelKey, maxLines = 1, all = false): Found[] {
  const collected: Found[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!labelSpans(line.text).some(s => s.key === key)) continue;

    const results: Found[] = [];
    const sameLine = stripLabels(line.text);
    if (sameLine.length > 0) results.push({ value: sameLine, confidence: line.confidence, index: i });

    for (let j = i + 1; j < lines.length && results.length < maxLines; j++) {
      const next = lines[j];
      if (isLabelLine(next.text)) {
        if (next.row === line.row && !stripLabels(next.text)) continue;
        break;
      }
      if (isMrzLine(next.text)) break;
      if (isNoiseLine(next.text) || !next.text.trim()) continue;
      results.push({ value: next.text.trim(), confidence: next.confidence, index: j });
    }
    collected.push(...results);
    if (collected.length > 0 && !all) return collected;
  }
  return collected;
}

/** The first found value that the parser accepts. */
function firstParsed<T>(found: Found[], parse: (v: string) => T | null): { value: T; confidence: number } | null {
  for (const f of found) {
    const value = parse(f.value);
    if (value !== null && value !== undefined) return { value, confidence: f.confidence };
  }
  return null;
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

/**
 * The bilingual value pair around the last "/" that has Cyrillic words on its left
 * and Latin words on its right: "б CОФИЯ/SOFIA" → СОФИЯ / SOFIA,
 * "ВЕЛИКО ТЪРНОВО/VELIKO TARNOVO" → both words on each side. Stray one-letter
 * tokens (leftovers of a misread label) are dropped. Falls back to splitBilingual.
 */
function bilingualPair(value: string): { cyrillic: string | null; latin: string | null } {
  const parts = value.split('/');
  for (let k = parts.length - 1; k >= 1; k--) {
    const left = parts.slice(0, k).join('/').trim().split(/\s+/).map(foldCyrillicLookalikes);
    const right = parts.slice(k).join('/').trim().split(/[\s\/]+/);
    const cyr: string[] = [];
    for (let i = left.length - 1; i >= 0 && hasCyrillic(left[i]) && /^[\p{L}\-]+$/u.test(left[i]); i--) cyr.unshift(left[i]);
    const latn: string[] = [];
    for (const t of right) { if (hasCyrillic(t) || !/^[A-Za-z\-]+$/.test(t)) break; latn.push(t); }
    const c = cyr.filter(t => t.length > 1);
    const l = latn.filter(t => t.length > 1);
    if (c.length && l.length) return { cyrillic: c.join(' '), latin: l.join(' ') };
  }
  return splitBilingual(value);
}

/** True when the whole token is a (possibly misread) label. */
function isLabelToken(token: string): boolean {
  return labelSpans(token).some(s => s.start === 0 && s.end >= token.length);
}

/** Clean a name: keep letters, spaces and hyphens; drop label words; fold stray look-alikes. */
function cleanName(value: string): string {
  const cleaned = value.replace(/[^A-Za-zЀ-ӿ\s'\-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return cleaned.split(' ')
    .filter(t => t.length > 1 && !isLabelToken(t))
    .map(t => (hasCyrillic(t) ? foldCyrillicLookalikes(t) : t))
    .join(' ');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Similarity 0..1 of a Cyrillic name (transliterated) and a Latin name. */
function nameSimilarity(cyrillic: string, latin: string): number {
  const a = transliterateBulgarian(cyrillic).replace(/[^A-Z]/g, '');
  const b = latin.toUpperCase().replace(/[^A-Z]/g, '');
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * From the value lines after a name label, take the Cyrillic and the Latin form.
 * When the two disagree (the Latin is not close to the transliterated Cyrillic),
 * the one read closer to the label wins and the other is dropped.
 */
function namePair(found: Found[]): { cyrillic: string | null; latin: string | null; confidence: number } {
  let cyrillic: { value: string; order: number; confidence: number } | null = null;
  let latin: { value: string; order: number; confidence: number } | null = null;
  let order = 0;
  for (const f of found) {
    for (const part of f.value.split('/')) {
      const name = cleanName(part);
      order++;
      if (name.length < 2 || isNoiseLine(name)) continue;
      if (hasCyrillic(name)) { if (!cyrillic) cyrillic = { value: name, order, confidence: f.confidence }; }
      else if (!latin) latin = { value: name, order, confidence: f.confidence };
    }
  }
  if (cyrillic && latin && nameSimilarity(cyrillic.value, latin.value) < 0.5) {
    if (cyrillic.order <= latin.order) latin = null; else cyrillic = null;
  }
  return {
    cyrillic: cyrillic?.value ?? null,
    latin: latin?.value ?? null,
    confidence: Math.max(cyrillic?.confidence ?? 0, latin?.confidence ?? 0),
  };
}

/** Nationality as an ICAO code; fixes the common misreads of BGR ("BGP", "BCR"). */
function nationalityCode(value: string, cyrillic: string | null): string | null {
  const folded = foldLatinLookalikes(value).toUpperCase();
  const codes = folded.match(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g) ?? [];
  if (codes.some(c => /^B[GC6][RP]$/.test(c)) || (cyrillic && /БЪЛГАР/i.test(cyrillic))) return 'BGR';
  return codes[0] ?? null;
}

/** Bulgarian cards print the Ministry of Interior as "МВР/MoI BGR" (often read "MBP/Mol BCR"). */
function issuingAuthority(value: string): { cyrillic: string; latin: string | null } {
  if (/(?<!\p{L})[MМ][BВ][PР](?!\p{L})|MBPIMOL/iu.test(value)) return { cyrillic: 'МВР', latin: 'MoI BGR' };
  return { cyrillic: value, latin: null };
}

const EYE_COLOURS: Record<string, string> = {
  КАФЯВИ: 'BROWN', СИНИ: 'BLUE', ЗЕЛЕНИ: 'GREEN', СИВИ: 'GREY', ЧЕРНИ: 'BLACK',
  ЛЕШНИКОВИ: 'HAZEL', 'СИНЬО-ЗЕЛЕНИ': 'BLUE-GREEN', 'СИВО-СИНИ': 'GREY-BLUE',
};

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

export interface LicenceCategoryRow { category: string; valid_from: string | null; valid_until: string | null; restrictions?: string }

/** Category rows of the licence back: a category code followed by one or two dates. */
function licenceCategoryRows(lines: BgOcrLine[]): Array<LicenceCategoryRow & { confidence: number }> {
  const rows: Array<LicenceCategoryRow & { confidence: number }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const t = foldLatinLookalikes(line.text).toUpperCase().trim();
    const m = t.match(/^(AM|A1|A2|A|B1|BE|B|C1E|C1|CE|C|D1E|D1|DE|D|TTB|TKT|TM)\b\s*(.*)$/);
    if (!m) continue;
    const dates = [...m[2].matchAll(new RegExp(DATE_RE.source, 'g'))].map(d => parseBgDate(d[0]));
    if (!dates.length || dates.every(d => d === null) || seen.has(m[1])) continue;
    seen.add(m[1]);
    const restrictions = m[2].replace(new RegExp(DATE_RE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
    rows.push({
      category: m[1], valid_from: dates[0] ?? null, valid_until: dates[1] ?? null,
      ...(restrictions ? { restrictions } : {}), confidence: line.confidence,
    });
  }
  return rows;
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
  const set = (key: string, value: BgExtraction['fields'][string], c: number) => {
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
    // Back side: one row per category — "B 10.03.2020 10.03.2030 [restriction codes]"
    // (columns 9 = category, 10 = valid from, 11 = valid until, 12 = restrictions).
    const rows = licenceCategoryRows(lines);
    if (rows.length) {
      const rowConf = Math.min(...rows.map(r => r.confidence));
      set('licence_category_validity', rows.map(({ confidence, ...r }) => r), rowConf);
      // The table lists every held category; it outranks the field-9 header row.
      set('licence_categories', rows.map(r => r.category), rowConf);
    }
  } else {
    // ID card / passport: bilingual labels, after splitting merged lines
    const seg = segmentLines(lines);
    const surname = namePair(findLabelled(seg, 'surname', 2, true));
    const given = namePair(findLabelled(seg, 'given', 2, true));
    const patronymic = namePair(findLabelled(seg, 'patronymic', 2, true));
    set('surname_cyrillic', surname.cyrillic, surname.confidence);
    set('surname_latin', surname.latin, surname.confidence);
    set('given_name_cyrillic', given.cyrillic, given.confidence);
    set('given_name_latin', given.latin, given.confidence);
    set('patronymic_cyrillic', patronymic.cyrillic, patronymic.confidence);
    set('patronymic_latin', patronymic.latin, patronymic.confidence);

    for (const key of ['date_of_birth', 'expiration_date', 'issue_date'] as const) {
      const d = firstParsed(findLabelled(seg, key, 2), parseBgDate);
      if (d) set(key, d.value, d.confidence);
    }

    const sexF = firstParsed(findLabelled(seg, 'sex', 2), parseSex);
    if (sexF) set('sex', sexF.value, sexF.confidence);

    const natF = findLabelled(seg, 'nationality', 1)[0];
    if (natF) {
      const n = bilingualPair(natF.value);
      const code = nationalityCode(n.latin ?? natF.value, n.cyrillic);
      set('nationality', code ?? n.latin ?? (n.cyrillic ? transliterateBulgarian(n.cyrillic) : null), natF.confidence);
      set('nationality_cyrillic', n.cyrillic, natF.confidence);
    }

    const egnF = firstParsed(findLabelled(seg, 'personal_number', 2), v => {
      const egn = normalizeEgn(v);
      return egn.length === 10 ? egn : null;
    });
    if (egnF) set('personal_number', egnF.value, egnF.confidence);

    const docF = firstParsed(findLabelled(seg, 'document_number', 2), parseBgDocumentNumber);
    if (docF) set('document_number', docF.value, docF.confidence);

    const pobF = findLabelled(seg, 'place_of_birth', 1)[0];
    if (pobF) {
      const p = bilingualPair(pobF.value);
      set('place_of_birth', p.cyrillic ?? p.latin, pobF.confidence);
      set('place_of_birth_latin', p.latin ?? (p.cyrillic ? transliterateBulgarian(p.cyrillic) : null), pobF.confidence);
    }

    const addrF = findLabelled(seg, 'address', 3);
    if (addrF.length) {
      // Addresses start with the province ("обл."); anything before it is a misread label.
      const address = addrF.map(f => f.value).join(', ').replace(/^.*?(?=обл\.)/iu, '').replace(/\s+/g, ' ');
      set('address', address, addrF[0].confidence);
    }

    const authF = findLabelled(seg, 'issuing_authority', 1)[0];
    if (authF) {
      const a = issuingAuthority(authF.value);
      set('issuing_authority', a.cyrillic, authF.confidence);
      set('issuing_authority_latin', a.latin, authF.confidence);
    }

    const hF = firstParsed(findLabelled(seg, 'height', 2), v => v.match(/(?<!\d)(1\d{2}|2[0-4]\d)(?!\d)/)?.[1] ?? null);
    if (hF) set('height', hF.value, hF.confidence);

    const eyeF = findLabelled(seg, 'eye_color', 1)[0];
    if (eyeF) {
      const e = bilingualPair(eyeF.value);
      const cyrEye = e.cyrillic?.toUpperCase() ?? null;
      set('eye_color', (cyrEye && EYE_COLOURS[cyrEye]) ?? e.latin ?? e.cyrillic, eyeF.confidence);
      set('eye_color_cyrillic', e.cyrillic, eyeF.confidence);
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
    // Residence permits carry a foreigner's ЛНЧ instead of an ЕГН.
    fields.personal_number_type = classifyPersonalNumber(fields.personal_number);
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
/** Generic name fields (name, first/last/middle name) from the Bulgarian name parts. */
function setGenericNames(ocrData: Record<string, any>, conf: Record<string, number> = {}): void {
  const latinName = [ocrData.given_name_latin, ocrData.patronymic_latin, ocrData.surname_latin].filter(Boolean).join(' ');
  const cyrName = [ocrData.given_name_cyrillic, ocrData.patronymic_cyrillic, ocrData.surname_cyrillic].filter(Boolean).join(' ');
  if (latinName) {
    ocrData.name = latinName;
    ocrData.confidence_scores.name = Math.max(conf.surname_latin ?? 0, conf.given_name_latin ?? 0, ocrData.confidence_scores.name ?? 0);
  }
  if (cyrName) ocrData.name_cyrillic = cyrName;
  if (ocrData.given_name_latin) ocrData.first_name = ocrData.given_name_latin;
  if (ocrData.surname_latin) ocrData.last_name = ocrData.surname_latin;
  if (ocrData.patronymic_latin) ocrData.middle_name = ocrData.patronymic_latin;
}

export function applyBulgarianExtraction(ocrData: Record<string, any>, extraction: BgExtraction): void {
  const f = extraction.fields;
  ocrData.confidence_scores = ocrData.confidence_scores ?? {};

  for (const [key, value] of Object.entries(f)) {
    ocrData[key] = value;
    if (extraction.confidence_scores[key] !== undefined) {
      ocrData.confidence_scores[key] = extraction.confidence_scores[key];
    }
  }

  setGenericNames(ocrData, extraction.confidence_scores);

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
  first_name?: string | null;
}

const mrzNorm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Drop surname words the MRZ does not confirm (e.g. "САИ ИВАНОВА", where "САИ" is a
 * misread "Surname" label), when the remaining words match the MRZ exactly.
 */
function trimSurnameToMrz(ocrData: Record<string, any>, mrzSurname: string): void {
  const target = mrzSurname.toUpperCase().split(/[\s<]+/).filter(Boolean).map(mrzNorm);
  if (target.length === 0) return;
  let changed = false;
  for (const [key, toLatin] of [['surname_cyrillic', transliterateBulgarian], ['surname_latin', (t: string) => t]] as const) {
    const value = ocrData[key];
    if (typeof value !== 'string') continue;
    const tokens = value.split(/\s+/);
    const keep = tokens.filter(t => target.includes(mrzNorm(toLatin(t))));
    if (keep.length > 0 && keep.length < tokens.length && mrzNorm(keep.map(toLatin).join('')) === target.join('')) {
      ocrData[key] = keep.join(' ');
      changed = true;
    }
  }
  if (changed) {
    if (ocrData.surname_latin_source === 'transliterated' && ocrData.surname_cyrillic) {
      ocrData.surname_latin = transliterateBulgarian(ocrData.surname_cyrillic);
    }
    ocrData.surname_trimmed_by_mrz = true;
    ocrData.confidence_scores = ocrData.confidence_scores ?? {};
    setGenericNames(ocrData);
  }
}

/**
 * Compare the visually read fields with the MRZ (checksum-protected) and record
 * the outcome per field under `mrz_cross_check` (true / false; absent when one side
 * is missing). Fills the ЕГН from the MRZ when the visual read missed it, and drops
 * surname words the MRZ shows to be misread labels. Other visually read values are
 * never changed — the decision stays with the caller.
 */
export function crossCheckBulgarianMrz(ocrData: Record<string, any>, mrz: BgMrzFields): void {
  const checks: Record<string, boolean> = {};

  const mrzEgn = mrz.personal_number ? normalizeEgn(mrz.personal_number) : '';
  if (mrzEgn.length === 10 && !ocrData.personal_number) {
    ocrData.personal_number = mrzEgn;
    ocrData.personal_number_valid = parseEgn(mrzEgn).valid;
    ocrData.confidence_scores = ocrData.confidence_scores ?? {};
    ocrData.confidence_scores.personal_number = 0.95;
  }
  if (mrz.last_name) trimSurnameToMrz(ocrData, mrz.last_name);

  const givenNames = [ocrData.given_name_latin, ocrData.patronymic_latin].filter(Boolean).join(' ');
  const pairs: Array<[string, unknown, unknown]> = [
    ['document_number', ocrData.document_number, mrz.document_number],
    ['date_of_birth', ocrData.date_of_birth, mrz.date_of_birth],
    ['expiration_date', ocrData.expiration_date, mrz.expiry_date],
    ['personal_number', ocrData.personal_number, mrzEgn || null],
    ['sex', ocrData.sex, mrz.sex === 'male' ? 'M' : mrz.sex === 'female' ? 'F' : mrz.sex],
    ['surname', ocrData.surname_latin, mrz.last_name],
    // A trailing one-letter token in the MRZ name line is OCR noise from the fillers ("GEORGIEVA<K<<").
    ['given_names', givenNames, mrz.first_name?.replace(/(?:\s+\S)+\s*$/, '')],
  ];
  for (const [field, visual, machine] of pairs) {
    if (!visual || !machine) continue;
    checks[field] = mrzNorm(visual) === mrzNorm(machine);
  }
  if (Object.keys(checks).length > 0) ocrData.mrz_cross_check = checks;
}
