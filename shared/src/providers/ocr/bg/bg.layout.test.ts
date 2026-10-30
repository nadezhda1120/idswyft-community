import { describe, it, expect } from 'vitest'
import { parseBulgarianLayout } from './layout.js'
import { FRONT_2024, BACK_2024, FRONT_2010, BACK_2010 } from './bg.layout.fixtures.js'

const values = (fields: Record<string, { value: string }>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value]))

describe('layout parser — 2024 ID card', () => {
  it('reads every field of the front from the box layout', () => {
    expect(values(parseBulgarianLayout(FRONT_2024, 'id_card_2024').fields)).toEqual({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      given_name_cyrillic: 'СЛАВИНА', given_name_latin: 'SLAVINA',
      patronymic_cyrillic: 'ГЕОРГИЕВА', patronymic_latin: 'GEORGIEVA',
      nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1995-08-01', sex: 'F', personal_number: '9508010133',
      expiration_date: '2034-06-17', document_number: 'AA0000000', can: '267503',
    })
  })

  it('takes values from the next box when the label stands alone', () => {
    const f = parseBulgarianLayout(FRONT_2024, 'id_card_2024').fields
    expect(f.expiration_date.source).toBe('right')      // "Baлugнocm/Date of expiry" | "17.06.2034"
    expect(f.document_number.source).toBe('right')      // "№ на документа /" | "'AA0000000"
    expect(f.surname_cyrillic.source).toBe('inline')    // "Фамилия ИВАНОВА"
  })

  it('reads the back, address over several rows', () => {
    expect(values(parseBulgarianLayout(BACK_2024, 'id_card_2024').fields)).toMatchObject({
      surname_cyrillic: 'ИВАНОВА',
      place_of_birth: 'СОФИЯ', place_of_birth_latin: 'SOFIA',
      address: 'Обл.СОФИЯ, общ.СТОЛИЧНА гр.СОФИЯ/СОFИА, 6ул.КНЯГИНЯ МАРИЯ ЛУИЗА 48 ет.5 ап.26',
      height: '168', eye_color_cyrillic: 'КАФЯВИ', eye_color: 'BROWN',
      issuing_authority: 'МВР', issuing_authority_latin: 'MoI BGR', issue_date: '2024-06-17',
    })
  })
})

describe('layout parser — 2010 ID card', () => {
  it('reads every field of the front, even where labels are misread', () => {
    expect(values(parseBulgarianLayout(FRONT_2010, 'id_card_2010').fields)).toEqual({
      surname_cyrillic: 'ИВАНОВА', surname_latin: 'IVANOVA',
      given_name_cyrillic: 'МАРИЦА', given_name_latin: 'MARITSA',
      patronymic_cyrillic: 'РАДНЕВА', patronymic_latin: 'RADNEVA',
      personal_number: '8508010133', sex: 'F',
      nationality: 'BGR', nationality_cyrillic: 'БЪЛГАРИЯ',
      date_of_birth: '1985-08-01', expiration_date: '2019-08-01', document_number: '600000000',
    })
  })

  it('reads the back; a label remnant before the value is ignored', () => {
    const f = values(parseBulgarianLayout(BACK_2010, 'id_card_2010').fields)
    expect(f).toMatchObject({
      surname_cyrillic: 'ИВАНОВА',                       // "ФамилияСаи ИВАНОВА"
      place_of_birth: 'СОФИЯ', place_of_birth_latin: 'SOFIA',
      eye_color_cyrillic: 'КАФЯВИ', eye_color: 'BROWN',
      issuing_authority: 'МВР', issue_date: '2009-08-01', // value 3 boxes to the right
    })
    expect(f.address.startsWith('обл.СОФИЯ')).toBe(true)
    expect(f.height).toBe('158')                         // misread on the specimen (168 printed)
  })

  it('does not take a 2024-format number on a 2010 card', () => {
    const f = parseBulgarianLayout(FRONT_2024, 'id_card_2010').fields
    expect(f.document_number).toBeUndefined()
  })
})

describe('layout parser — real-photo label misreads', () => {
  // Synthetic values on the label misreads seen on a real phone photo of a 2010 card
  const b = (text: string, x: number, y: number, w = 0.1, h = 0.04, confidence = 0.9) => ({ text, confidence, x, y, w, h })
  const card = [
    b('Фамилия', 0.34, 0.28), b('ПЕТРОВ', 0.44, 0.27),
    b('Surame', 0.34, 0.32), b('PETROV', 0.44, 0.32),
    b('Mne', 0.34, 0.37, 0.05), b('иЛия', 0.44, 0.36, 0.09, 0.04, 0.55),
    b('Name', 0.33, 0.41, 0.07), b('ILIA', 0.44, 0.41, 0.07),
    b('Пресиме', 0.34, 0.46), b('ИВАНОВ', 0.44, 0.46),
    b('№е на документа Dосителт питbег', 0.34, 0.75, 0.31, 0.03), b('612345678', 0.72, 0.75, 0.2),
  ]

  it('reads the fields despite the misread labels', () => {
    expect(values(parseBulgarianLayout(card, 'id_card_2010').fields)).toEqual({
      surname_cyrillic: 'ПЕТРОВ', surname_latin: 'PETROV',
      given_name_cyrillic: 'ИЛИЯ', given_name_latin: 'ILIA',
      patronymic_cyrillic: 'ИВАНОВ',
      document_number: '612345678',
    })
  })

  it('does not take a mixed-case remnant right after a label as a name', () => {
    const f = parseBulgarianLayout([b('ФамилияСаи', 0.03, 0.11, 0.2)], 'id_card_2010').fields
    expect(f.surname_cyrillic).toBeUndefined()
  })
})
