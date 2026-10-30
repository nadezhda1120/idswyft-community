import { describe, it, expect } from 'vitest'
import { confirmBulgarianFields } from './confirm.js'

// SYNTHETIC values only. 9508010139: valid ЕГН, 1995-08-01, F.

const FRONT = {
  surname_cyrillic: 'ПЕТРОВА', surname_latin: 'PETROVA',
  given_name_cyrillic: 'ЯНА', given_name_latin: 'YANA',
  patronymic_cyrillic: 'ИВАНОВА', patronymic_latin: 'IVANOVA',
  document_number: 'AA1234567', date_of_birth: '1995-08-01', expiration_date: '2034-06-16',
  personal_number: '9508010139', sex: 'F', nationality: 'BGR',
}
const MRZ = {
  fields: {
    document_number: 'AA1234567', date_of_birth: '1995-08-01', expiry_date: '2034-06-16',
    last_name: 'PETROVA', first_name: 'YANA IVANOVA', sex: 'female', nationality: 'BGR', personal_number: '9508010139',
  },
  check_digits: { document_number: true, date_of_birth: true, expiry_date: true, composite: true },
  raw_lines: ['IDBGRAA12345674<<<<<<<<<<<<<<<', '9508015F3406164BGR9508010139<0', 'PETROVA<<YANA<IVANOVA<<<<<<<<<'],
}
const BACK = { surname_cyrillic: 'ПЕТРОВА' }

describe('confirmBulgarianFields', () => {
  it('confirms every field when front, back and MRZ agree', () => {
    const r = confirmBulgarianFields(FRONT, BACK, MRZ)
    expect(r.all_critical_confirmed).toBe(true)
    expect(r.review_fields).toEqual([])
    for (const f of ['surname', 'given_name', 'patronymic', 'document_number', 'date_of_birth', 'expiry_date', 'personal_number', 'sex', 'nationality']) {
      expect(r.fields[f].status, f).toBe('confirmed')
    }
    expect(r.fields.date_of_birth.sources).toEqual({ front: '1995-08-01', mrz: '1995-08-01', personal_number: '1995-08-01' })
    expect(r.fields.surname.value).toBe('ПЕТРОВА')
  })

  it('a misread letter in the Cyrillic name sends it to review, naming the source', () => {
    const r = confirmBulgarianFields({ ...FRONT, surname_cyrillic: 'ПЕТРОБА' }, BACK, MRZ)
    expect(r.fields.surname.status).toBe('conflict')
    expect(r.fields.surname.disagreeing).toEqual(['front_cyrillic'])
    expect(r.fields.surname.value).toBe('PETROVA')
    expect(r.all_critical_confirmed).toBe(false)
    expect(r.review_fields).toEqual([{ field: 'surname', status: 'conflict', reason: 'surname: front_cyrillic differs from front_latin, mrz, back_cyrillic' }])
  })

  it('a misread Latin name is caught even when the dates and numbers are perfect', () => {
    const r = confirmBulgarianFields({ ...FRONT, given_name_latin: 'YAMA' }, BACK, MRZ)
    expect(r.fields.given_name.status).toBe('conflict')
    expect(r.review_fields.map(f => f.field)).toEqual(['given_name'])
  })

  it('without the back side the names are only single-source: review', () => {
    const r = confirmBulgarianFields({ ...FRONT, surname_latin: undefined, surname_latin_source: undefined }, {}, null)
    expect(r.fields.surname.status).toBe('single_source')
    expect(r.fields.document_number.status).toBe('single_source')
    // The date of birth is still confirmed by the ЕГН
    expect(r.fields.date_of_birth.status).toBe('confirmed')
    expect(r.all_critical_confirmed).toBe(false)
  })

  it('a transliterated Latin name is not counted as a second source', () => {
    const r = confirmBulgarianFields({ ...FRONT, surname_latin_source: 'transliterated' }, {}, null)
    expect(r.fields.surname.status).toBe('single_source')
  })

  it('ignores an MRZ field whose check digit failed', () => {
    const r = confirmBulgarianFields(FRONT, BACK, { ...MRZ, check_digits: { ...MRZ.check_digits, date_of_birth: false }, fields: { ...MRZ.fields, date_of_birth: '1995-08-07' } })
    expect(r.fields.date_of_birth.sources.mrz).toBeUndefined()
    expect(r.fields.date_of_birth.status).toBe('confirmed') // front + ЕГН
  })

  it('a different MRZ document number is a conflict', () => {
    const r = confirmBulgarianFields(FRONT, BACK, { ...MRZ, fields: { ...MRZ.fields, document_number: 'AA1234568' } })
    expect(r.fields.document_number.status).toBe('conflict')
  })

  it('reads O as 0 in the digits of a document number', () => {
    const r = confirmBulgarianFields({ ...FRONT, document_number: 'AA12O4567' }, BACK, { ...MRZ, fields: { ...MRZ.fields, document_number: 'AA1204567' } })
    expect(r.fields.document_number.status).toBe('confirmed')
  })

  it('an ЕГН with a failing checksum is invalid even when both sources agree', () => {
    const bad = '9508010138'
    const r = confirmBulgarianFields({ ...FRONT, personal_number: bad }, BACK, { ...MRZ, fields: { ...MRZ.fields, personal_number: bad } })
    expect(r.fields.personal_number.status).toBe('invalid')
    expect(r.review_fields.map(f => f.field)).toContain('personal_number')
    // ...and it no longer vouches for the date of birth or sex
    expect(r.fields.date_of_birth.sources.personal_number).toBeUndefined()
  })

  it('drops filler noise at the end of the MRZ given names', () => {
    const r = confirmBulgarianFields(FRONT, BACK, { ...MRZ, fields: { ...MRZ.fields, first_name: 'YANA IVANOVA K' } })
    expect(r.fields.patronymic.status).toBe('confirmed')
  })

  it('accepts a truncated MRZ name as a prefix of the printed one', () => {
    const long = { ...FRONT, surname_cyrillic: 'ХРИСТОДОРОВА-КОНСТАНТИНОВА', surname_latin: 'HRISTODOROVA-KONSTANTINOVA' }
    const r = confirmBulgarianFields(long, {}, {
      ...MRZ,
      fields: { ...MRZ.fields, last_name: 'HRISTODOROVA KONSTANTINO', first_name: 'YA' },
      raw_lines: [MRZ.raw_lines[0], MRZ.raw_lines[1], 'HRISTODOROVA<KONSTANTINO<<YANA'],
    })
    expect(r.fields.surname.status).toBe('confirmed')
  })
})
