import { describe, it, expect } from 'vitest'
import { extractBulgarianDocument, applyBulgarianExtraction, crossCheckBulgarianMrz } from './BulgarianExtractor.js'
import { formatBulgarianDocument } from './format.js'

// Raw PaddleOCR (PP-OCRv5 Cyrillic) output for the public Wikimedia specimen cards
// (fictitious holders). Kept verbatim, including the OCR's mixed-script misreads and
// the merged middle line, so the extractor is tested against what the engine really emits.

const lines = (texts: string[], confidence = 0.85) => texts.map(text => ({ text, confidence }))

const FRONT_2010 = lines([
  'ЕВРОПЕЙСКИ СЪЮЗ EUROPEAN UNION',
  'РЕПУБЛИКА БЪЛГАРИЯ 0 REPUBLIC OF BULGARIA',
  'ЛИЧНА КАРТА IDENTITY CARD',
  'Фамилия ИВАНОВА',
  " Surname IVANOVA Име МАРИЦА Name MARITSA Презиме РАДНЕВА Father's name RADNEVA ETH/Personal No 8508010133 Pол/Сех Ж/F ГражданствоNатiола/у БЪЛГАРИЯ/BGP Дата на ражданеDate of birth 01.08.1985",
  'Валидност/Date of expiry 01.08.2019',
  '№ на документа/Dоситент питbер 600000000',
  ' Подпис/Signature',
])

const FRONT_2024 = lines([
  'РЕПУБЛИКА БЪЛГАРИЯ REPUBLIC OF BULGARIA',
  'BG*',
  '',
  'ЛИЧНА КАРТА IDENTITY CARD',
  'Фамилия ИВАНОВА',
  " Surname IVANOVA Име СЛАВИНА Name SLAVINA Презиме ГЕОРГИЕВА Father's name GEORGIEVA ГражgaнсmBо/Nationality БЪЛГАРИЯ/BGP Даmа на раждане/Date of birth 01.08.1995 Пол/Sex Ж/F ErH/Personal No 9508010133",
  'Baлugнocm/Date of expiry 17.06.2034',
  "№ на документа / 'AA0000000",
  'Document number',
  '267503',
  'Пognuc/Signature',
])

const BACK_2010 = lines([
  'ФамилияСаи ИВАНОВА',
  'Място на рааиеРласе б CОФИЯ/SOFIA',
  'Постоянен ацдескес обл.СОФИЯ',
  'общ. СТОЛИЧНА  СОФИЯ/СОФИА',
  'ул.ИВАМ ВАЗОВ 63 eT.4',
  'Pbcr/Heigh 158 Lт нa oчите/ Color of eyes КАФЯВИ/BPOWN',
  'Издаден отАитае. MBPIMol BGR',
  'Дата на издаванеДате 20 ssue',
  '01.08.2009',
  'IDBGR6000000002<<<<<<<<<<<<<<<',
  '8508018F1908011BGR8508010133<1',
  'IVANOVA<<MARITSA<RADNEVA<<<<<<',
])

const BACK_2024 = lines([
  'Фамилия/Sигпате ИВАНОВА',
  'Място на раждане/Place of birth. СОФИЯ/SOFIA',
  'Постоянен адрес/Ресіденсе Обл.СОФИЯ',
  'общ.СТОЛИЧНА гр.СОФИЯ/СОFИА',
  '6ул.КНЯГИНЯ МАРИЯ ЛУИЗА 48 ет.5 ап.26',
  'Pbcm/Height 168 Вт на очитеCok of eyesКАФЯВИ/BROWN',
  'Издаgeн om/Authority MBP/Mol BCR',
  'Дата на издаване/Date of ss 17.06.2024',
  'IDBGRAA0O00OO00<<<<<<<<<<<<<<<',
  '9508015F3406175BGR9508010133<0',
  'IVANOVA<<SLAVINA<GEORGIEVA<K<<',
])

describe('Wikimedia specimen — 2010 ID card front', () => {
  const { layout, fields } = extractBulgarianDocument(FRONT_2010)

  it('identifies the card', () => {
    expect(layout).toMatchObject({ document: 'id_card', generation: 'id_card_2010', side: 'front' })
  })

  it('splits the merged line and reads every field', () => {
    expect(fields).toMatchObject({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      given_name_cyrillic: 'МАРИЦА', given_name_latin: 'MARITSA',
      patronymic_cyrillic: 'РАДНЕВА', patronymic_latin: 'RADNEVA',
      personal_number: '8508010133',
      sex: 'F', nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1985-08-01', expiration_date: '2019-08-01',
      document_number: '600000000',
    })
    // The specimen's ЕГН is fictitious and fails the checksum.
    expect(fields.personal_number_valid).toBe(false)
  })

  it('still compares the ЕГН date with the date of birth when the checksum fails', () => {
    expect(fields.personal_number_matches_dob).toBe(true)
  })

  it('compares the ЕГН with the MRZ date of birth', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(FRONT_2010))
    // MRZ of the specimen back: 8508018F1908011BGR8508010133<1
    crossCheckBulgarianMrz(ocr, { date_of_birth: '1985-08-01', personal_number: '8508010133' })
    expect(ocr.mrz_cross_check).toMatchObject({
      date_of_birth: true, personal_number: true, personal_number_vs_mrz_date_of_birth: true,
    })
  })

  it('builds a clean full name', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(FRONT_2010))
    expect(ocr.name).toBe('MARITSA RADNEVA IVANOVA')
    expect(ocr.name_cyrillic).toBe('МАРИЦА РАДНЕВА ИВАНОВА')
  })
})

describe('Wikimedia specimen — 2024 ID card front', () => {
  const { layout, fields } = extractBulgarianDocument(FRONT_2024)

  it('identifies the 2024 generation from the letter document number', () => {
    expect(layout).toMatchObject({ document: 'id_card', generation: 'id_card_2024', side: 'front' })
  })

  it('reads every field', () => {
    expect(fields).toMatchObject({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      given_name_cyrillic: 'СЛАВИНА', given_name_latin: 'SLAVINA',
      patronymic_cyrillic: 'ГЕОРГИЕВА', patronymic_latin: 'GEORGIEVA',
      personal_number: '9508010133',
      sex: 'F', nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1995-08-01', expiration_date: '2034-06-17',
      document_number: 'AA0000000',
    })
  })
})

describe('Wikimedia specimen — 2010 ID card back', () => {
  const { layout, fields } = extractBulgarianDocument(BACK_2010)

  it('identifies the card', () => {
    expect(layout).toMatchObject({ document: 'id_card', generation: 'id_card_2010', side: 'back' })
  })

  it('reads the back fields despite garbled labels', () => {
    expect(fields).toMatchObject({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      place_of_birth: 'СОФИЯ', place_of_birth_latin: 'SOFIA',
      issuing_authority: 'МВР', issuing_authority_latin: 'MoI BGR',
      issue_date: '2009-08-01', height: '158',
      eye_color: 'BROWN', eye_color_cyrillic: 'КАФЯВИ',
    })
    expect(String(fields.address)).toMatch(/^обл\.СОФИЯ, общ\. СТОЛИЧНА/)
  })
})

describe('Wikimedia specimen — 2024 ID card back', () => {
  const { layout, fields } = extractBulgarianDocument(BACK_2024)

  it('identifies the 2024 generation from the MRZ document number', () => {
    expect(layout).toMatchObject({ document: 'id_card', generation: 'id_card_2024', side: 'back' })
  })

  it('reads the back fields', () => {
    expect(fields).toMatchObject({
      surname_cyrillic: 'ИВАНОВА',
      place_of_birth: 'СОФИЯ', place_of_birth_latin: 'SOFIA',
      issuing_authority: 'МВР', issuing_authority_latin: 'MoI BGR',
      issue_date: '2024-06-17', height: '168',
      eye_color: 'BROWN',
    })
    expect(String(fields.address)).toMatch(/^Обл\.СОФИЯ/)
  })
})

describe('MRZ surname trim', () => {
  it('drops a misread label word that the MRZ does not confirm', () => {
    const ocr: Record<string, any> = {
      surname_cyrillic: 'САИ ИВАНОВА', surname_latin: 'SAI IVANOVA', surname_latin_source: 'transliterated',
      confidence_scores: {},
    }
    crossCheckBulgarianMrz(ocr, { last_name: 'IVANOVA', first_name: 'MARITSA RADNEVA' })
    expect(ocr.surname_cyrillic).toBe('ИВАНОВА')
    expect(ocr.surname_latin).toBe('IVANOVA')
    expect(ocr.surname_trimmed_by_mrz).toBe(true)
    expect(ocr.mrz_cross_check.surname).toBe(true)
  })
})

describe('MRZ given-names check', () => {
  it('ignores a trailing one-letter noise token in the MRZ name', () => {
    const ocr: Record<string, any> = { given_name_latin: 'SLAVINA', patronymic_latin: 'GEORGIEVA', confidence_scores: {} }
    crossCheckBulgarianMrz(ocr, { first_name: 'SLAVINA GEORGIEVA K' })
    expect(ocr.mrz_cross_check.given_names).toBe(true)
  })
})

describe('formatBulgarianDocument', () => {
  it('groups a 2024 front into document / holder / quality, without empty values', () => {
    const ocr: Record<string, any> = { raw_text: '', ocr_script: 'cyrillic' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(FRONT_2024))
    const doc = formatBulgarianDocument(ocr)
    expect(doc).toMatchObject({
      document: { country: 'BG', type: 'id_card', generation: 'id_card_2024', side: 'front', number: 'AA0000000', expiry_date: '2034-06-17' },
      holder: {
        full_name: { cyrillic: 'СЛАВИНА ГЕОРГИЕВА ИВАНОВА', latin: 'SLAVINA GEORGIEVA IVANOVA' },
        surname: { cyrillic: 'ИВАНОВА', latin: 'IVANOVA' },
        father_name: { cyrillic: 'ГЕОРГИЕВА', latin: 'GEORGIEVA' },
        personal_number: { number: '9508010133', type: 'egn', checksum_valid: false },
        date_of_birth: '1995-08-01', sex: 'F',
        nationality: { code: 'BGR', cyrillic: 'БЪЛГАРИЯ' },
      },
      quality: { ocr_script: 'cyrillic' },
    })
    expect(doc).not.toHaveProperty('mrz')
    expect(doc.holder).not.toHaveProperty('address')
  })
})

describe('formatBulgarianDocument — MRZ block', () => {
  it('strips the one-letter filler noise from the MRZ given names', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(BACK_2024))
    const doc = formatBulgarianDocument(ocr, {
      format: 'TD1', check_digits_valid: true,
      fields: { document_number: 'AA0000000', last_name: 'IVANOVA', first_name: 'SLAVINA GEORGIEVA K' },
    })
    expect(doc.mrz).toMatchObject({ given_names: 'SLAVINA GEORGIEVA', check_digits_valid: true })
    expect(doc.document).toMatchObject({ issue_date: '2024-06-17', generation: 'id_card_2024' })
  })
})

describe('personal number type on ID cards', () => {
  it('is an ЕГН on a citizen ID card even when the checksum fails or passes ЛНЧ by chance', () => {
    // 9508010133 fails the ЕГН checksum but happens to pass the ЛНЧ one.
    expect(extractBulgarianDocument(FRONT_2024).fields.personal_number_type).toBe('egn')
    expect(extractBulgarianDocument(FRONT_2010).fields.personal_number_type).toBe('egn')
  })

  it('is set when the number comes from the MRZ on the back', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(BACK_2024))
    crossCheckBulgarianMrz(ocr, { personal_number: '9508010133', last_name: 'IVANOVA' })
    expect(ocr.personal_number_type).toBe('egn')
  })
})
