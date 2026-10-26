import { describe, it, expect } from 'vitest'
import { extractBulgarianDocument, applyBulgarianExtraction, crossCheckBulgarianMrz } from './BulgarianExtractor.js'
import { lnchChecksumValid, classifyPersonalNumber } from './egn.js'
import { formatBulgarianDocument } from './format.js'
import { validateIdNumber, getCountryFormat } from '../internationalIdFormats.js'

// NOTE: every name, number and ЕГН below is SYNTHETIC — never real card data.

const lines = (texts: string[], confidence = 0.9) => texts.map(text => ({ text, confidence }))

describe('Bulgarian passport (trilingual labels, TD3 MRZ)', () => {
  const page = lines([
    'РЕПУБЛИКА БЪЛГАРИЯ REPUBLIC OF BULGARIA REPUBLIQUE DE BULGARIE',
    'ПАСПОРТ PASSPORT PASSEPORT',
    'Тип/Type/Type P Код/Code BGR',
    'Паспорт №/Passport No./Passeport N° 381234567',
    'Фамилия/Surname/Nom',
    'ПЕТРОВА',
    'PETROVA',
    'Име/Given names/Prénoms',
    'ЯНА',
    'YANA',
    "Презиме/Father's name",
    'ИВАНОВА',
    'IVANOVA',
    'Гражданство/Nationality/Nationalité БЪЛГАРИЯ/BGR',
    'Дата на раждане/Date of birth/Date de naissance 01.08.1995',
    'ЕГН/Personal No./No personnel 9508010139',
    'Пол/Sex/Sexe Ж/F',
    'Място на раждане/Place of birth/Lieu de naissance ВАРНА/VARNA',
    'Дата на издаване/Date of issue/Date de délivrance 17.06.2024',
    "Валидност/Date of expiry/Date d'expiration 16.06.2034",
    'Издаден от/Authority/Autorité МВР/MoI BGR',
    'P<BGRPETROVA<<YANA<IVANOVA<<<<<<<<<<<<<<<<<<',
    '3812345673BGR9508015F34061649508010139<<<<46',
  ])

  it('identifies a passport data page', () => {
    const { layout } = extractBulgarianDocument(page)
    expect(layout).toMatchObject({ document: 'passport', side: 'data_page', generation: 'passport_2010' })
    expect(layout.signals).toContain('mrz_td3_bgr')
  })

  it('reads every visual field, without French label words in values', () => {
    const { fields } = extractBulgarianDocument(page)
    expect(fields).toMatchObject({
      surname_cyrillic: 'ПЕТРОВА', surname_latin: 'PETROVA',
      given_name_cyrillic: 'ЯНА', given_name_latin: 'YANA',
      patronymic_cyrillic: 'ИВАНОВА', patronymic_latin: 'IVANOVA',
      nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1995-08-01', sex: 'F',
      personal_number: '9508010139', personal_number_valid: true, personal_number_type: 'egn',
      document_number: '381234567',
      place_of_birth: 'ВАРНА', place_of_birth_latin: 'VARNA',
      issue_date: '2024-06-17', expiration_date: '2034-06-16',
      issuing_authority: 'МВР', issuing_authority_latin: 'MoI BGR',
    })
  })

  it('cross-checks the visual fields against the MRZ', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(page))
    crossCheckBulgarianMrz(ocr, {
      document_number: '381234567', date_of_birth: '1995-08-01', expiry_date: '2034-06-16',
      personal_number: '9508010139', sex: 'female', last_name: 'PETROVA', first_name: 'YANA IVANOVA',
    })
    expect(ocr.mrz_cross_check).toEqual({
      document_number: true, date_of_birth: true, expiration_date: true,
      personal_number: true, sex: true, surname: true, given_names: true,
      personal_number_vs_mrz_date_of_birth: true,
    })
    expect(ocr.detected_document_type).toBe('passport')
  })

  it('does not require an ЕГН', () => {
    const noEgn = page.filter(l => !/ЕГН|9508010139/.test(l.text))
    const { fields } = extractBulgarianDocument(noEgn)
    expect(fields.personal_number).toBeUndefined()
    expect(fields.document_number).toBe('381234567')
  })
})

describe('Bulgarian driving licence back (category table)', () => {
  const back = lines([
    '9.        10.         11.        12.',
    'AM 10.03.2020 10.03.2030',
    'B1 10.03.2020 10.03.2030',
    'B 10.03.2020 10.03.2030 78',
    'C',
    '14. 01.08.2006',
  ])

  it('identifies the back and reads per-category validity', () => {
    const { layout, fields } = extractBulgarianDocument(back)
    expect(layout).toMatchObject({ document: 'driving_licence', side: 'back' })
    expect(fields.licence_categories).toEqual(['AM', 'B1', 'B'])
    expect(fields.licence_category_validity).toEqual([
      { category: 'AM', valid_from: '2020-03-10', valid_until: '2030-03-10' },
      { category: 'B1', valid_from: '2020-03-10', valid_until: '2030-03-10' },
      { category: 'B', valid_from: '2020-03-10', valid_until: '2030-03-10', restrictions: '78' },
    ])
    expect(formatBulgarianDocument({ ...fields, bg_layout: layout }).document).toMatchObject({
      type: 'driving_licence', licence_categories: ['AM', 'B1', 'B'],
    })
  })
})

describe('ЛНЧ (foreigner personal number)', () => {
  it('validates the ЛНЧ checksum and tells it apart from an ЕГН', () => {
    // 100000000 → 21·1 = 21 → check digit 1
    expect(lnchChecksumValid('1000000001')).toBe(true)
    expect(lnchChecksumValid('1000000002')).toBe(false)
    expect(classifyPersonalNumber('1000000001')).toBe('lnch')
    expect(classifyPersonalNumber('9508010139')).toBe('egn')
    expect(classifyPersonalNumber('1234567890')).toBe('unknown')
  })
})

describe('Bulgaria in the international format registry', () => {
  it('registers BG ID card, passport and licence number formats', () => {
    expect(getCountryFormat('BG', 'national_id')).not.toBeNull()
    expect(validateIdNumber('BG', 'national_id', '600000000')).toBe(true)
    expect(validateIdNumber('BG', 'national_id', 'AA0000000')).toBe(true)
    expect(validateIdNumber('BG', 'national_id', 'A123')).toBe(false)
    expect(validateIdNumber('BG', 'passport', '381234567')).toBe(true)
    expect(validateIdNumber('BG', 'drivers_license', '123456789')).toBe(true)
  })
})
