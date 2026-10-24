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

/** Latin capital letters that are visually identical to a Bulgarian Cyrillic letter. */
const LATIN_LOOKALIKE_TO_CYRILLIC: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т',
  Y: 'У', X: 'Х',
};

/**
 * Fold Cyrillic look-alike letters to Latin inside tokens that are clearly Latin
 * or machine-readable: a Cyrillic recognition model often emits "А" for "A" in
 * MRZ lines and document numbers.
 *
 * A whitespace-separated token is folded only when it contains a Latin letter,
 * a digit or the MRZ filler "<", and every Cyrillic letter in it has a Latin twin.
 * Pure Cyrillic words (names, labels) are left untouched.
 */
export function foldLatinLookalikes(line: string): string {
  if (!line || !hasCyrillic(line)) return line;
  return line.replace(/[^\s\/]+/g, (token) => {
    if (!hasCyrillic(token)) return token;
    if (!/[A-Za-z0-9<]/.test(token)) return token;
    const cyr = token.match(/[Ѐ-ӿ]/g) ?? [];
    if (!cyr.every(ch => ch in CYRILLIC_LOOKALIKE_TO_LATIN)) return token;
    return token.replace(/[Ѐ-ӿ]/g, ch => CYRILLIC_LOOKALIKE_TO_LATIN[ch] ?? ch);
  });
}

/**
 * Fold Latin look-alike letters to Cyrillic inside tokens that are otherwise
 * Cyrillic (e.g. "ИBAHOBA" → "ИВАНОВА"). Used on the Cyrillic name fields only.
 */
export function foldCyrillicLookalikes(token: string): string {
  if (!token || !hasCyrillic(token)) return token;
  if (/[0-9<]/.test(token)) return token;
  const latin = token.match(/[A-Za-z]/g) ?? [];
  if (!latin.every(ch => ch.toUpperCase() in LATIN_LOOKALIKE_TO_CYRILLIC)) return token;
  return token.replace(/[A-Za-z]/g, ch => {
    const cyr = LATIN_LOOKALIKE_TO_CYRILLIC[ch.toUpperCase()];
    if (!cyr) return ch;
    return ch === ch.toUpperCase() ? cyr : cyr.toLowerCase();
  });
}
