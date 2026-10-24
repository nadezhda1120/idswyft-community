import { describe, it, expect } from 'vitest'
import { transliterateBulgarian, foldLatinLookalikes, foldCyrillicLookalikes } from './transliteration.js'
import { parseEgn, findEgnInText } from './egn.js'
import { extractBulgarianDocument, applyBulgarianExtraction, parseBgDate, parseBgDocumentNumber } from './BulgarianExtractor.js'

// NOTE: every name, number and ЕГН below is SYNTHETIC — never real card data.

const line = (text: string, confidence = 0.95) => ({ text, confidence })

describe('transliterateBulgarian', () => {
  it('follows the Streamlined System', () => {
    expect(transliterateBulgarian('ИВАНОВА')).toBe('IVANOVA')
    expect(transliterateBulgarian('ЖЕЛЯЗКОВ')).toBe('ZHELYAZKOV')
    expect(transliterateBulgarian('ЩЕРЮ ЦВЕТАНОВ')).toBe('SHTERYU TSVETANOV')
    expect(transliterateBulgarian('ЪГЪЛ')).toBe('AGAL')
    expect(transliterateBulgarian('ЬО')).toBe('YO')
  })

  it('renders word-final ИЯ as IA and the exception БЪЛГАРИЯ', () => {
    expect(transliterateBulgarian('МАРИЯ')).toBe('MARIA')
    expect(transliterateBulgarian('ЯНА')).toBe('YANA')
    expect(transliterateBulgarian('БЪЛГАРИЯ')).toBe('BULGARIA')
    expect(transliterateBulgarian('София')).toBe('Sofia')
  })

  it('leaves Latin text unchanged', () => {
    expect(transliterateBulgarian('IVAN 123')).toBe('IVAN 123')
  })
})

describe('look-alike folding', () => {
  it('folds Cyrillic look-alikes inside MRZ and number tokens only', () => {
    expect(foldLatinLookalikes('IDВGRАА1234567<5')).toBe('IDBGRAA1234567<5')
    expect(foldLatinLookalikes('АА1234567')).toBe('AA1234567')
    expect(foldLatinLookalikes('ИВАНОВА')).toBe('ИВАНОВА')
    expect(foldLatinLookalikes('ОТТО')).toBe('ОТТО')
  })

  it('folds Latin look-alikes inside Cyrillic names', () => {
    expect(foldCyrillicLookalikes('ИBAHOBA')).toBe('ИВАНОВА')
    expect(foldCyrillicLookalikes('IVANOVA')).toBe('IVANOVA')
  })
})

describe('ЕГН', () => {
  it('validates the checksum and decodes date and sex', () => {
    expect(parseEgn('9508010139')).toEqual({ valid: true, checksum_valid: true, date_of_birth: '1995-08-01', sex: 'F' })
    expect(parseEgn('8802290005')).toMatchObject({ valid: true, date_of_birth: '1988-02-29', sex: 'M' })
    expect(parseEgn('0541050317')).toMatchObject({ valid: true, date_of_birth: '2005-01-05' })
  })

  it('rejects a bad checksum or an impossible date', () => {
    expect(parseEgn('9508010138').valid).toBe(false)
    expect(parseEgn('9513010130').valid).toBe(false)
    expect(parseEgn('123').valid).toBe(false)
  })

  it('finds a valid ЕГН in free text', () => {
    expect(findEgnInText('No 1234567890 ЕГН 9508010139')).toBe('9508010139')
  })
})

describe('Bulgarian value parsers', () => {
  it('parses DD.MM.YYYY dates', () => {
    expect(parseBgDate('01.08.1995')).toBe('1995-08-01')
    expect(parseBgDate('17. 06. 2034')).toBe('2034-06-17')
    expect(parseBgDate('31.02.2020')).toBeNull()
  })

  it('parses document numbers, folding look-alikes', () => {
    expect(parseBgDocumentNumber('AA1234567')).toBe('AA1234567')
    expect(parseBgDocumentNumber('АА 1234567')).toBe('AA1234567')
    expect(parseBgDocumentNumber('643 123 456')).toBe('643123456')
  })
})

describe('extractBulgarianDocument — ID card front (2010 layout)', () => {
  const front = [
    line('РЕПУБЛИКА БЪЛГАРИЯ REPUBLIC OF BULGARIA'),
    line('ЛИЧНА КАРТА IDENTITY CARD'),
    line('Фамилия/Surname'),
    line('ИВАНОВА'),
    line('IVANOVA'),
    line('Име/Name'),
    line('СЛАВИНА'),
    line('SLAVINA'),
    line('Презиме/Father\'s name'),
    line('ГЕОРГИЕВА'),
    line('GEORGIEVA'),
    line('Гражданство/Nationality БЪЛГАРИЯ/BGR'),
    line('Дата на раждане/Date of birth 01.08.1995'),
    line('Пол/Sex Ж/F'),
    line('ЕГН/Personal No 9508010139'),
    line('Валидност/Date of expiry 17.06.2034'),
    line('№ на документа/Document number 643123456'),
  ]

  it('identifies the layout', () => {
    const { layout } = extractBulgarianDocument(front)
    expect(layout.document).toBe('id_card')
    expect(layout.side).toBe('front')
    expect(layout.generation).toBe('id_card_2010')
  })

  it('extracts Cyrillic and Latin names and the other fields', () => {
    const { fields } = extractBulgarianDocument(front)
    expect(fields).toMatchObject({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      given_name_cyrillic: 'СЛАВИНА', given_name_latin: 'SLAVINA',
      patronymic_cyrillic: 'ГЕОРГИЕВА', patronymic_latin: 'GEORGIEVA',
      nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1995-08-01', sex: 'F',
      personal_number: '9508010139', personal_number_valid: true,
      personal_number_matches_dob: true, personal_number_matches_sex: true,
      expiration_date: '2034-06-17', document_number: '643123456',
    })
  })

  it('maps onto the generic OCR shape', () => {
    const ocr: Record<string, any> = { raw_text: '' }
    applyBulgarianExtraction(ocr, extractBulgarianDocument(front))
    expect(ocr.name).toBe('SLAVINA GEORGIEVA IVANOVA')
    expect(ocr.name_cyrillic).toBe('СЛАВИНА ГЕОРГИЕВА ИВАНОВА')
    expect(ocr.first_name).toBe('SLAVINA')
    expect(ocr.last_name).toBe('IVANOVA')
    expect(ocr.detected_document_type).toBe('national_id')
    expect(ocr.issuing_country).toBe('BG')
    expect(ocr.confidence_scores.document_number).toBeGreaterThan(0)
  })

  it('transliterates when the Latin line was not read', () => {
    const noLatin = front.filter(l => !['IVANOVA', 'SLAVINA', 'GEORGIEVA'].includes(l.text))
    const { fields } = extractBulgarianDocument(noLatin)
    expect(fields.surname_latin).toBe('IVANOVA')
    expect(fields.surname_latin_source).toBe('transliterated')
  })

  it('fills date of birth and sex from the ЕГН when their labels were missed', () => {
    const partial = front.filter(l => !/Date of birth|Sex/.test(l.text))
    const { fields } = extractBulgarianDocument(partial)
    expect(fields.date_of_birth).toBe('1995-08-01')
    expect(fields.sex).toBe('F')
  })
})

describe('extractBulgarianDocument — ID card back', () => {
  const back = [
    line('Място на раждане/Place of birth СОФИЯ/SOFIA'),
    line('Постоянен адрес/Residence'),
    line('обл.СОФИЯ общ.СТОЛИЧНА'),
    line('гр.СОФИЯ/SOFIA ул.ПРИМЕРНА 1'),
    line('Ръст/Height 168 Цвят на очите/Color of eyes КАФЯВИ/BROWN'),
    line('Издаден от/Authority МВР/MoI BGR'),
    line('Дата на издаване/Date of issue 17.06.2024'),
    line('IDBGRAA12345674<<<<<<<<<<<<<<<'),
    line('9508015F3406172BGR9508010139<0'),
    line('IVANOVA<<SLAVINA<GEORGIEVA<<<<'),
  ]

  it('detects the back side and reads its fields', () => {
    const { layout, fields } = extractBulgarianDocument(back)
    expect(layout.document).toBe('id_card')
    expect(layout.side).toBe('back')
    expect(fields).toMatchObject({
      place_of_birth: 'СОФИЯ', place_of_birth_latin: 'SOFIA',
      issuing_authority: 'МВР', issuing_authority_latin: 'MoI BGR', issue_date: '2024-06-17',
      height: '168', eye_color: 'BROWN', eye_color_cyrillic: 'КАФЯВИ',
    })
    expect(fields.address).toContain('СТОЛИЧНА')
  })
})

describe('extractBulgarianDocument — driving licence', () => {
  const dl = [
    line('РЕПУБЛИКА БЪЛГАРИЯ'),
    line('СВИДЕТЕЛСТВО ЗА УПРАВЛЕНИЕ НА МПС'),
    line('1. ПЕТРОВ'),
    line('PETROV'),
    line('2. ГЕОРГИ ИВАНОВ'),
    line('GEORGI IVANOV'),
    line('3. 29.02.1988 ПЛОВДИВ/PLOVDIV'),
    line('4a. 10.03.2020 4c. МВР ПЛОВДИВ'),
    line('4b. 10.03.2030'),
    line('4d. 8802290005'),
    line('5. 123456789'),
    line('9. AM B1 B'),
  ]

  it('reads the numbered EU fields', () => {
    const { layout, fields } = extractBulgarianDocument(dl)
    expect(layout.document).toBe('driving_licence')
    expect(fields).toMatchObject({
      surname_cyrillic: 'ПЕТРОВ', surname_latin: 'PETROV',
      given_name_cyrillic: 'ГЕОРГИ', patronymic_cyrillic: 'ИВАНОВ',
      given_name_latin: 'GEORGI', patronymic_latin: 'IVANOV',
      date_of_birth: '1988-02-29', place_of_birth: 'ПЛОВДИВ',
      issue_date: '2020-03-10', expiration_date: '2030-03-10',
      personal_number: '8802290005', personal_number_valid: true,
      document_number: '123456789',
      licence_categories: ['AM', 'B1', 'B'],
    })
  })
})
