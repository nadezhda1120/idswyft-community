/**
 * Readable summary of a Bulgarian document read.
 *
 * The engine's `result.ocr` is a flat bag of every field the pipeline produced
 * (plus raw text and per-field scores). This turns it into a small nested object
 * grouped the way a person reads the card: document, holder, MRZ, quality.
 * Empty values are left out. Pure: no I/O.
 */

export interface BgMrzSummaryInput {
  format?: string | null;
  check_digits_valid?: boolean;
  fields?: Record<string, unknown>;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Drop null / undefined / '' / empty objects and arrays, recursively. */
function compact(value: unknown): Json | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((v): v is Json => v !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = compact(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value as Json;
}

const pair = (cyrillic: unknown, latin: unknown) => ({ cyrillic, latin });

export function formatBulgarianDocument(
  ocr: Record<string, any>,
  mrz?: BgMrzSummaryInput | null,
): Record<string, Json> {
  const layout = ocr.bg_layout ?? {};
  const scores: Record<string, number> = ocr.confidence_scores ?? {};
  const lowConfidence = Object.entries(scores)
    .filter(([, v]) => typeof v === 'number' && v < 0.7)
    .map(([k]) => k)
    .sort();

  const summary = {
    document: {
      country: ocr.issuing_country ?? 'BG',
      type: layout.document ?? ocr.detected_document_type,
      generation: layout.generation,
      side: layout.side,
      number: ocr.document_number,
      issue_date: ocr.issue_date,
      expiry_date: ocr.expiration_date,
      issuing_authority: pair(ocr.issuing_authority, ocr.issuing_authority_latin),
      licence_categories: ocr.licence_categories,
      licence_category_validity: ocr.licence_category_validity,
    },
    holder: {
      full_name: pair(ocr.name_cyrillic, ocr.name),
      surname: pair(ocr.surname_cyrillic, ocr.surname_latin),
      given_name: pair(ocr.given_name_cyrillic, ocr.given_name_latin),
      father_name: pair(ocr.patronymic_cyrillic, ocr.patronymic_latin),
      latin_transliterated: [
        ocr.surname_latin_source === 'transliterated' && 'surname',
        ocr.given_name_latin_source === 'transliterated' && 'given_name',
        ocr.patronymic_latin_source === 'transliterated' && 'father_name',
      ].filter(Boolean),
      personal_number: {
        number: ocr.personal_number,
        type: ocr.personal_number_type,
        checksum_valid: ocr.personal_number_valid,
        matches_date_of_birth: ocr.personal_number_matches_dob,
        matches_sex: ocr.personal_number_matches_sex,
      },
      date_of_birth: ocr.date_of_birth,
      sex: ocr.sex,
      nationality: { code: ocr.nationality, cyrillic: ocr.nationality_cyrillic },
      place_of_birth: pair(ocr.place_of_birth, ocr.place_of_birth_latin),
      address: ocr.address,
      height_cm: ocr.height ? Number(ocr.height) : undefined,
      eye_color: pair(ocr.eye_color_cyrillic, ocr.eye_color),
    },
    mrz: mrz ? {
      format: mrz.format,
      check_digits_valid: mrz.check_digits_valid,
      document_number: mrz.fields?.document_number,
      surname: mrz.fields?.last_name,
      // A trailing one-letter token is filler noise ("GEORGIEVA<K<<"), not a name.
      given_names: typeof mrz.fields?.first_name === 'string'
        ? mrz.fields.first_name.replace(/(?:\s+\S)+\s*$/, '')
        : undefined,
      date_of_birth: mrz.fields?.date_of_birth,
      expiry_date: mrz.fields?.expiry_date,
      personal_number: mrz.fields?.personal_number,
      matches_visual: ocr.mrz_cross_check,
    } : undefined,
    quality: {
      ocr_script: ocr.ocr_script,
      layout_confidence: layout.confidence,
      low_confidence_fields: lowConfidence,
      surname_trimmed_by_mrz: ocr.surname_trimmed_by_mrz,
    },
  };
  return (compact(summary) ?? {}) as Record<string, Json>;
}
