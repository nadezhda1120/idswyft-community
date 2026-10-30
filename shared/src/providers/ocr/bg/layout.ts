/**
 * Layout-aware parser for Bulgarian identity cards (2010 and 2024 generations).
 *
 * Works on the recognizer's individual text boxes with their positions, not on
 * its line grouping (one large empty box over the photo area merges half the
 * card into a single "line"). Every box is split into label and value segments;
 * a field's value is taken from, in order:
 *   1. the same box, after the label        "Фамилия ИВАНОВА"
 *   2. the nearest box to the right, same row   "Date of expiry" | "17.06.2034"
 *   3. the box right below, same column
 * Labels are matched in both languages, tolerating the usual misreads
 * ("ErH/Personal No", "Baлugнocm/Date of expiry"). Only relations between boxes
 * are used, never absolute positions, so the result does not depend on how the
 * card was cropped. Every value is validated before it is accepted, and its
 * source and OCR confidence are reported.
 *
 * Pure and deterministic.
 */

import { foldLatinLookalikes, foldCyrillicLookalikes, transliterateBulgarian, hasCyrillic } from './transliteration.js';
import { normalizeEgn } from './egn.js';

/** A recognized text box; coordinates are fractions (0–1) of the image size. */
export interface BgBox {
  text: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BgValueSource = 'inline' | 'right' | 'below' | 'pattern';

export interface BgLayoutValue {
  value: string;
  confidence: number;
  source: BgValueSource;
}

export interface BgLayoutResult {
  /** Same keys as BulgarianExtractor fields (surname_cyrillic, date_of_birth, ...) */
  fields: Record<string, BgLayoutValue>;
}

type Concept =
  | 'surname' | 'given_name' | 'patronymic' | 'nationality' | 'date_of_birth' | 'sex' | 'personal_number'
  | 'expiration_date' | 'document_number' | 'place_of_birth' | 'address' | 'height' | 'eye_color'
  | 'issuing_authority' | 'issue_date' | 'signature';

/** [concept, pattern, label language]. Cyrillic and English labels, with common OCR misreads. */
const LABELS: Array<[Concept, RegExp, 'cyr' | 'lat']> = [
  ['surname', /Ф[аa]м[иu]л[иu][яa]/giu, 'cyr'],
  ['surname', /S[uи]r?n?[aа]m[eе]|S[иu]г[пn][аa]т[еe]/giu, 'lat'],
  ['patronymic', /Пр[еe][зс][иu]м[еe]/giu, 'cyr'],
  ['patronymic', /F[aа]th[eе]r['’`]?s?\s*n[aа]m[eе]/giu, 'lat'],
  ['given_name', /(?<![А-Яа-яЁё])Им[еe](?![А-Яа-яЁё])|(?<![A-Za-z])Mn[eе](?![A-Za-z])/giu, 'cyr'],
  ['given_name', /(?<![A-Za-z'’`])N[aа]m[eе](?![A-Za-z])/giu, 'lat'],
  ['nationality', /Гр[аa]ж[дg][аa]нс[тm][вB][оo]/giu, 'cyr'],
  ['nationality', /N[aа]t[iі][oо]n[aа]l[iі]ty|N[aа]т[iі][oо]л[aа]/giu, 'lat'],
  ['date_of_birth', /Д[аa][тm][аa]\s*н[аa]\s*р[аa]жд[аa]н[еe]/giu, 'cyr'],
  ['date_of_birth', /D[aа]t[eе]\s*[oо]f\s*b[iі]rth/giu, 'lat'],
  ['issue_date', /Д[аa][тm][аa]\s*н[аa]\s*[иu]зд[аa]в[аa]н[еe]/giu, 'cyr'],
  ['issue_date', /D[aа]t[eе]\s*[oо]f\s*[iі1]ss(?:ue)?/giu, 'lat'],
  ['expiration_date', /В[аa]л[иu][дg]н[оo][сc][тm]|B[aа]л[uи][gд]н[oо][cс][mт]/giu, 'cyr'],
  ['expiration_date', /D[aа]t[eе]\s*[oо]f\s*[eе]xp[iі]ry/giu, 'lat'],
  ['sex', /(?<![А-Яа-яA-Za-z])[ПP][оo]л(?![А-Яа-я])/giu, 'cyr'],
  ['sex', /(?<![A-Za-zА-Яа-я])[SС][eе][xх](?![A-Za-zА-Яа-я])/giu, 'lat'],
  ['personal_number', /ЕГН|E[ГTFr]H/gu, 'cyr'],
  ['personal_number', /P[eе]rs[oо]n[aа]l\s*N[oо]/giu, 'lat'],
  ['document_number', /№\s*[еe]?\s*на\s*док[уy]м[еe]нт[аa]/giu, 'cyr'],
  ['document_number', /D[oо][cс][uи]m[eе]nt\s*n[uи]mb[eе]r|D[oо][cс][иu]т[еe][нл]т\s*п[иu]т/giu, 'lat'],
  ['place_of_birth', /М[яa][сc][тm][оo]\s*н[аa]\s*р/giu, 'cyr'],
  ['place_of_birth', /Pl[aа][cс][eе]\s*[oо]f\s*b[iі]rth/giu, 'lat'],
  ['address', /П[оo][сc][тm][оo][яa]н[еe]н(?:\s*[аa][дg]р[еe][сc])?/giu, 'cyr'],
  ['address', /R[eе]s[iі]d[eе]n[cс][eе]|Р[еe][сc][іi][дg][еe]н[сc][еe]/giu, 'lat'],
  ['height', /Р[ъb][сc][тm]|Pb[cс][mrт]/giu, 'cyr'],
  ['height', /H[eе][iі]gh[tт]?/giu, 'lat'],
  ['eye_color', /Цв[яa][тm]\s*н[аa]\s*[оo]ч[иu][тm][еe]|[оo]ч[иu][тm][еe]/giu, 'cyr'],
  ['eye_color', /C[oо][lк]?[oо]?r?\s*[oо]f\s*[eе]y[eе]s|[oо]f\s*[eе]y[eе]s/giu, 'lat'],
  ['issuing_authority', /[ИU]зд[аa][дg][еe][нh]\s*[оo][тm]/giu, 'cyr'],
  ['issuing_authority', /A[uи]th[oо]r[iі]?ty|A[uи]th[oо]r/giu, 'lat'],
  ['signature', /П[оo][дg]п[иu][сc]|S[iі]gn[aа]t[uи]r[eе]/giu, 'cyr'],
];

const HEADER_RE = /РЕПУБЛИКА|REPUBLIC|ЛИЧНА\s*КАРТА|IDENTITY\s*CARD|ЕВРОПЕЙСКИ|EUROPEAN\s*UNION|CARTE\s*D/i;
const isMrz = (t: string) => /^[A-Z0-9<]{25,}$/.test(t.replace(/\s/g, '')) && t.includes('<');

interface Hit { concept: Concept; lang: 'cyr' | 'lat'; start: number; end: number }

function labelHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const [concept, re, lang] of LABELS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ concept, lang, start: m.index!, end: m.index! + m[0].length });
  }
  // Earliest first; at the same start the longest wins; drop hits inside an earlier one
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Hit[] = [];
  for (const h of hits) if (!out.length || h.start >= out[out.length - 1].end) out.push(h);
  return out;
}

interface Item extends BgBox {
  index: number;
  hits: Hit[];
  /** Text before the first label (all of it when the box has no label) */
  prefix: string;
}

const cleanSegment = (s: string) => s.replace(/^[\s\/:.,;|'’`\-]+/, '').replace(/\s+/g, ' ').trim();

// ── Geometry ─────────────────────────────────────────────────

const cy = (b: BgBox) => b.y + b.h / 2;
const sameRow = (a: BgBox, b: BgBox) => Math.abs(cy(a) - cy(b)) < 0.6 * Math.max(a.h, b.h);
const rightOf = (a: BgBox, b: BgBox) => b.x > a.x + a.w * 0.5;
const below = (a: BgBox, b: BgBox) => b.y > a.y + a.h * 0.5 && b.y - (a.y + a.h) < 1.4 * a.h && Math.abs(b.x - a.x) < 0.08;

/**
 * Candidate value boxes for a label: every box to its right on the same row, in
 * order, up to the next box that starts another label; then the box below it.
 */
function neighbours(items: Item[], item: Item): Array<{ item: Item; source: BgValueSource }> {
  const out: Array<{ item: Item; source: BgValueSource }> = [];
  for (const o of items.filter(o => o !== item && sameRow(item, o) && rightOf(item, o)).sort((a, b) => a.x - b.x)) {
    if (o.prefix) out.push({ item: o, source: 'right' });
    if (o.hits.length) break;
  }
  const down = items.filter(o => o !== item && below(item, o)).sort((a, b) => a.y - b.y)[0];
  if (down) out.push({ item: down, source: 'below' });
  return out;
}

// ── Value parsers (return null when the value is not valid) ──

const DATE_RE = /(\d{1,2})\s*[.\/\-]\s*(\d{1,2})\s*[.\/\-]\s*(\d{4})/;
function parseDate(text: string): string | null {
  const m = foldLatinLookalikes(text).replace(/[OoОо]/g, '0').match(DATE_RE);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Uppercase name tokens in one script. Mixed-case words after a label are label
 * remnants ("ФамилияСаи"), not names. A box that holds only the value may be read
 * in mixed case ("иЛия" for ИЛИЯ): with wholeBox, an all-Cyrillic word is accepted
 * and uppercased.
 */
function nameTokens(text: string, lang: 'cyr' | 'lat', wholeBox = false): { cyrillic: string | null; latin: string | null } {
  const cyr: string[] = [];
  const lat: string[] = [];
  for (const raw of text.split(/[\s\/,]+/)) {
    let token = raw.replace(/^[^A-Za-zА-Яа-яЁё]+|[^A-Za-zА-Яа-яЁё\-]+$/g, '');
    if (wholeBox && /^[А-Яа-яЁё\-]{2,}$/.test(token)) token = token.toUpperCase();
    if (token.length < 2 || token !== token.toUpperCase()) continue;
    const hasCyrOnly = /[БГДЖЗИЙЛПФЦЧШЩЪЬЮЯ]/.test(token);
    const hasLatOnly = /[DFGIJLNQRSUVWZ]/.test(token);
    if (hasCyrOnly || (!hasLatOnly && hasCyrillic(token) && lang === 'cyr')) {
      const folded = foldCyrillicLookalikes(token);
      if (/^[А-ЯЁ\-]+$/.test(folded)) cyr.push(folded);
    } else if (hasLatOnly || lang === 'lat' || !hasCyrillic(token)) {
      const folded = foldLatinLookalikes(token).replace(/[А-Яа-я]/g, '');
      if (/^[A-Z\-]+$/.test(folded) && folded.length === token.length) lat.push(folded);
    } else {
      const folded = foldCyrillicLookalikes(token);
      if (/^[А-ЯЁ\-]+$/.test(folded)) cyr.push(folded);
    }
  }
  return { cyrillic: cyr.join(' ') || null, latin: lat.join(' ') || null };
}

function parseSex(text: string): string | null {
  const t = text.toUpperCase();
  if (/(?:^|[\s\/])(?:Ж|F)(?:$|[\s\/])/.test(t)) return 'F';
  if (/(?:^|[\s\/])(?:М|M)(?:$|[\s\/])/.test(t)) return 'M';
  return null;
}

function parseEgn(text: string): string | null {
  const m = foldLatinLookalikes(text).replace(/[OoОо]/g, '0').match(/(?<!\d)\d{10}(?!\d)/);
  return m ? normalizeEgn(m[0]) : null;
}

function parseDocNumber(text: string, generation: string | null): string | null {
  const t = foldLatinLookalikes(text).toUpperCase().replace(/[\s'’`]/g, '');
  // 2024: two letters + seven digits; 2010: nine digits. O read for 0 in the digits.
  const m2024 = t.match(/(?<![A-Z0-9])([A-Z]{2})([0-9O]{7})(?![A-Z0-9])/);
  if (m2024 && generation !== 'id_card_2010') return m2024[1] + m2024[2].replace(/O/g, '0');
  const m2010 = t.replace(/O/g, '0').match(/(?<![A-Z0-9])(\d{9})(?![A-Z0-9])/);
  if (m2010 && generation !== 'id_card_2024') return m2010[1];
  return null;
}

function bilingual(text: string): { cyrillic: string | null; latin: string | null } {
  let cyrillic: string | null = null;
  let latin: string | null = null;
  for (const part of text.split('/').map(p => p.trim()).filter(Boolean)) {
    const words = part.split(/\s+/).filter(w => w.length >= 2 && w === w.toUpperCase());
    if (!words.length) continue;
    const joined = words.join(' ');
    if (/[БГДЖЗИЙЛПФЦЧШЩЪЬЮЯ]/.test(joined) && !cyrillic) cyrillic = foldCyrillicLookalikes(joined);
    else if (!latin && /[A-Z]/.test(joined)) latin = foldLatinLookalikes(joined).replace(/[^A-Z\s\-]/g, '').trim() || null;
    else if (!cyrillic) cyrillic = foldCyrillicLookalikes(joined);
  }
  return { cyrillic, latin };
}

const EYE_COLOURS: Record<string, string> = {
  КАФЯВИ: 'BROWN', СИНИ: 'BLUE', ЗЕЛЕНИ: 'GREEN', СИВИ: 'GREY', ЧЕРНИ: 'BLACK',
  'СИВО-ЗЕЛЕНИ': 'GREY-GREEN', 'СИНЬО-ЗЕЛЕНИ': 'BLUE-GREEN', ЛЕШНИКОВИ: 'HAZEL',
};

// ── Parser ───────────────────────────────────────────────────

export function parseBulgarianLayout(boxes: BgBox[], generation: string | null): BgLayoutResult {
  const items: Item[] = boxes
    .map((b, index) => ({ ...b, text: (b.text ?? '').trim(), index }))
    .filter(b => b.text && !HEADER_RE.test(b.text) && !isMrz(b.text))
    .map(b => {
      const hits = labelHits(b.text);
      return { ...b, hits, prefix: cleanSegment(hits.length ? b.text.slice(0, hits[0].start) : b.text) };
    });

  const fields: Record<string, BgLayoutValue> = {};
  const set = (key: string, value: string | null, confidence: number, source: BgValueSource) => {
    if (value && !fields[key]) fields[key] = { value, confidence: Number(confidence.toFixed(3)), source };
  };

  for (const item of items) {
    item.hits.forEach((hit, i) => {
      const next = item.hits[i + 1];
      // "Даmа на раждане/Date of birth 01.08.1995": the Cyrillic label's segment is
      // empty because the English one follows; the value belongs to both.
      if (next && next.concept === hit.concept && !cleanSegment(item.text.slice(hit.end, next.start))) return;
      const inline = cleanSegment(item.text.slice(hit.end, next ? next.start : undefined));
      const candidates: Array<{ text: string; confidence: number; source: BgValueSource }> = [];
      if (inline) candidates.push({ text: inline, confidence: item.confidence, source: 'inline' });
      if (!next) {
        for (const n of neighbours(items, item)) {
          if (n.item.prefix) candidates.push({ text: n.item.prefix, confidence: n.item.confidence, source: n.source });
        }
      }
      parseConcept(hit, candidates, item, items, generation, set);
    });
  }

  // 2024 card: the 6-digit CAN printed under the document number (used to open the chip)
  if (generation === 'id_card_2024') {
    const docItem = items.find(i => i.hits.some(h => h.concept === 'document_number'));
    const can = docItem && items
      .filter(o => o.y > docItem.y && o.y - docItem.y < 0.15 && /^\d{6}$/.test(o.text.replace(/\s/g, '')))
      .sort((a, b) => a.y - b.y)[0];
    if (can) set('can', can.text.replace(/\s/g, ''), can.confidence, 'below');
  }

  return { fields };
}

type Setter = (key: string, value: string | null, confidence: number, source: BgValueSource) => void;

function parseConcept(
  hit: Hit,
  candidates: Array<{ text: string; confidence: number; source: BgValueSource }>,
  item: Item,
  items: Item[],
  generation: string | null,
  set: Setter,
): void {
  const first = <T>(parse: (t: string) => T | null): { value: T; confidence: number; source: BgValueSource } | null => {
    for (const c of candidates) {
      const value = parse(c.text);
      if (value) return { value, confidence: c.confidence, source: c.source };
    }
    return null;
  };

  switch (hit.concept) {
    case 'surname':
    case 'given_name':
    case 'patronymic': {
      let r: { value: ReturnType<typeof nameTokens>; confidence: number; source: BgValueSource } | null = null;
      for (const c of candidates) {
        const n = nameTokens(c.text, hit.lang, c.source !== 'inline');
        if (n.cyrillic || n.latin) { r = { value: n, confidence: c.confidence, source: c.source }; break; }
      }
      if (!r) return;
      set(`${hit.concept}_cyrillic`, r.value.cyrillic, r.confidence, r.source);
      set(`${hit.concept}_latin`, r.value.latin, r.confidence, r.source);
      return;
    }
    case 'date_of_birth':
    case 'expiration_date':
    case 'issue_date': {
      const r = first(parseDate);
      if (r) set(hit.concept, r.value, r.confidence, r.source);
      return;
    }
    case 'sex': {
      const r = first(parseSex);
      if (r) set('sex', r.value, r.confidence, r.source);
      return;
    }
    case 'personal_number': {
      const r = first(parseEgn);
      if (r) set('personal_number', r.value, r.confidence, r.source);
      return;
    }
    case 'document_number': {
      const r = first(t => parseDocNumber(t, generation));
      if (r) set('document_number', r.value, r.confidence, r.source);
      return;
    }
    case 'nationality': {
      const r = first(t => {
        const u = foldLatinLookalikes(t).toUpperCase();
        const bulgarian = /БЪЛГАРИЯ|BULGAR/.test(t.toUpperCase()) || /\bB[GС6][RР]\b|\bBG[RP]?\b/.test(u);
        return bulgarian ? 'BGR' : null;
      });
      if (r) {
        set('nationality', r.value, r.confidence, r.source);
        if (candidates.some(c => /БЪЛГАРИЯ/.test(c.text.toUpperCase()))) set('nationality_cyrillic', 'БЪЛГАРИЯ', r.confidence, r.source);
      }
      return;
    }
    case 'place_of_birth': {
      const r = first(t => {
        const b = bilingual(t);
        return b.cyrillic || b.latin ? b : null;
      });
      if (!r) return;
      set('place_of_birth', r.value.cyrillic ?? r.value.latin, r.confidence, r.source);
      set('place_of_birth_latin', r.value.latin ?? (r.value.cyrillic ? transliterateBulgarian(r.value.cyrillic) : null), r.confidence, r.source);
      return;
    }
    case 'height': {
      const r = first(t => t.match(/(?<!\d)(1\d{2}|2[0-3]\d)(?!\d)/)?.[1] ?? null);
      if (r) set('height', r.value, r.confidence, r.source);
      return;
    }
    case 'eye_color': {
      const r = first(t => {
        const b = bilingual(t);
        return b.cyrillic || b.latin ? b : null;
      });
      if (!r) return;
      const cyr = r.value.cyrillic?.replace(/\s+/g, '') ?? null;
      set('eye_color_cyrillic', cyr, r.confidence, r.source);
      set('eye_color', (cyr && EYE_COLOURS[cyr]) ?? r.value.latin, r.confidence, r.source);
      return;
    }
    case 'issuing_authority': {
      const r = first(t => (/М[ВB][РP]|M[BВ][PР]/.test(t.toUpperCase()) ? 'МВР' : null));
      if (r) {
        set('issuing_authority', r.value, r.confidence, r.source);
        set('issuing_authority_latin', 'MoI BGR', r.confidence, r.source);
      }
      return;
    }
    case 'address': {
      // The value continues on the rows below, in the label's column, until the next label
      const parts: string[] = [];
      const confidences: number[] = [];
      const inline = candidates.find(c => c.source === 'inline');
      if (inline) { parts.push(inline.text); confidences.push(inline.confidence); }
      for (const c of candidates.filter(c => c.source === 'right')) { parts.push(c.text); confidences.push(c.confidence); }
      let last: BgBox = item;
      for (const o of items.filter(o => o.y > item.y + item.h * 0.5).sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (o.y - (last.y + last.h) > 1.5 * last.h) break;
        if (Math.abs(o.x - item.x) > 0.08 && !sameRow(last, o)) continue;
        if (o.hits.length && !o.prefix) break;
        if (o.prefix) { parts.push(o.prefix); confidences.push(o.confidence); }
        if (o.hits.length) break;
        last = o;
      }
      // Addresses start with the province; anything before it is a misread label
      const address = parts.join(', ').replace(/\s+/g, ' ').replace(/^.*?(?=обл\.)/iu, '').trim();
      if (/обл\.|общ\.|гр\.|с\.|ул\.|бул\.|ж\.к\./iu.test(address)) {
        set('address', address, Math.min(...confidences), inline ? 'inline' : 'below');
      }
      return;
    }
    default:
      return;
  }
}
