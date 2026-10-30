/**
 * Bulgarian Cyrillic → Latin transliteration.
 *
 * Implements the official Streamlined System (Transliteration Act, State Gazette
 * 19/2009), which is the system printed on Bulgarian ID cards, passports and
 * driving licences. Deterministic: the same input always yields the same output,
 * so it is safe to use in cross-validation.
 */

const BG_TO_LATIN: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'Y',
  К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U',
  Ф: 'F', Х: 'H', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SHT', Ъ: 'A', Ь: 'Y', Ю: 'YU', Я: 'YA',
};

const CYRILLIC_RE = /[Ѐ-ӿ]/;

/** True when the string contains at least one Cyrillic letter. */
export function hasCyrillic(text: string): boolean {
  return CYRILLIC_RE.test(text);
}

/**
 * Transliterate Bulgarian Cyrillic text to Latin per the Streamlined System.
 *
 * - "ИЯ" at the end of a word becomes "IA" (e.g. "МАРИЯ" → "MARIA"), as the Act requires.
 * - The single exception word "БЪЛГАРИЯ" is rendered "BULGARIA".
 * - Characters that are not Bulgarian Cyrillic pass through unchanged.
 * - Output case follows input case per word (all-caps in → all-caps out).
 */
export function transliterateBulgarian(text: string): string {
  if (!text || !hasCyrillic(text)) return text;

  return text.replace(/[Ѐ-ӿ]+/g, (word) => {
    const upper = word.toUpperCase();
    let latin: string;
    if (upper === 'БЪЛГАРИЯ') {
      latin = 'BULGARIA';
    } else {
      let out = '';
      for (let i = 0; i < upper.length; i++) {
        const ch = upper[i];
        // Word-final "ИЯ" → "IA"
        if (ch === 'Я' && i === upper.length - 1 && i > 0 && upper[i - 1] === 'И') {
          out += 'A';
          continue;
        }
        out += BG_TO_LATIN[ch] ?? ch;
      }
      latin = out;
    }
    return matchCase(word, latin);
  });
}

function matchCase(source: string, latin: string): string {
  if (source === source.toUpperCase()) return latin;
  if (source === source.toLowerCase()) return latin.toLowerCase();
  // Title case
  return latin.charAt(0) + latin.slice(1).toLowerCase();
}

// ── Latin / Cyrillic look-alikes ──────────────────────────────

/** Cyrillic letters that are visually identical to a Latin capital letter. */
const CYRILLIC_LOOKALIKE_TO_LATIN: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T',
  У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
};

/**
 * Latin letters that are visually identical to a Bulgarian Cyrillic letter. Upper
 * and lower case are separate: lowercase b, h, k, m, t are NOT twins of в, н, к,
 * м, т (and in the italic labels on the cards "m" is what т looks like).
 */
const LATIN_LOOKALIKE_TO_CYRILLIC: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т',
  Y: 'У', X: 'Х',
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', y: 'у', x: 'х',
};

/** A Latin letter with no Cyrillic twin (D, F, G, I, … and lowercase b, h, k, m, t …) */
const LATIN_ONLY_RE = /[A-Za-z]/;
const isLatinOnly = (ch: string) => LATIN_ONLY_RE.test(ch) && !(ch in LATIN_LOOKALIKE_TO_CYRILLIC);

/**
 * Fold Cyrillic look-alike letters to Latin inside tokens that are clearly Latin
 * or machine-readable: a Cyrillic recognition model often emits "А" for "A" in
 * MRZ lines and document numbers.
 *
 * A whitespace-separated token is folded only when there is evidence it is not
 * Cyrillic: a digit, the MRZ filler "<", or a Latin letter that has no Cyrillic
 * twin ("ВGР" → "BGP", "АА1234567" → "AA1234567"); and only when every Cyrillic
 * letter in it has a Latin twin. A word made only of twin letters ("MАРК") is left
 * as read: whether it is Cyrillic or Latin is decided later from its label.
 */
export function foldLatinLookalikes(line: string): string {
  if (!line || !hasCyrillic(line)) return line;
  return line.replace(/[^\s\/]+/g, (token) => {
    if (!hasCyrillic(token)) return token;
    if (!/[0-9<]/.test(token) && ![...token].some(isLatinOnly)) return token;
    const cyr = token.match(/[Ѐ-ӿ]/g) ?? [];
    if (!cyr.every(ch => ch in CYRILLIC_LOOKALIKE_TO_LATIN)) return token;
    return token.replace(/[Ѐ-ӿ]/g, ch => CYRILLIC_LOOKALIKE_TO_LATIN[ch] ?? ch);
  });
}

/**
 * Fold Latin look-alike letters to Cyrillic inside tokens that are otherwise
 * Cyrillic (e.g. "ИBAHOBA" → "ИВАНОВА"). Each case maps only to its own twin.
 * Used on the Cyrillic name and value fields.
 */
export function foldCyrillicLookalikes(token: string): string {
  if (!token || !hasCyrillic(token)) return token;
  if (/[0-9<]/.test(token)) return token;
  const latin = token.match(/[A-Za-z]/g) ?? [];
  if (!latin.every(ch => ch in LATIN_LOOKALIKE_TO_CYRILLIC)) return token;
  return token.replace(/[A-Za-z]/g, ch => LATIN_LOOKALIKE_TO_CYRILLIC[ch] ?? ch);
}

/**
 * Fold a token made only of twin letters to Cyrillic ("MАРК" → "МАРК"), for a
 * value whose label says it is Cyrillic. Unlike foldCyrillicLookalikes it also
 * applies when no Cyrillic letter is left ("MAPK"), since the label decides.
 */
export function foldTwinsToCyrillic(token: string): string {
  if (!token || /[0-9<]/.test(token) || [...token].some(isLatinOnly)) return token;
  return token.replace(/[A-Za-z]/g, ch => LATIN_LOOKALIKE_TO_CYRILLIC[ch] ?? ch);
}
