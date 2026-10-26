import { describe, it, expect } from 'vitest'
import { egnMatchesDate } from './egn.js'
import { crossCheckBulgarianMrz } from './BulgarianExtractor.js'

// NOTE: every ЕГН below is SYNTHETIC — never real card data.
// 9508010139: valid, 1995-08-01, F. 9508010138: same date, wrong check digit.

describe('egnMatchesDate', () => {
  it('matches the date encoded in the first six digits', () => {
    expect(egnMatchesDate('9508010139', '1995-08-01')).toBe(true)
    expect(egnMatchesDate('0541050317', '2005-01-05')).toBe(true) // month + 40 → 2000s
  })

  it('ignores the check digit', () => {
    expect(egnMatchesDate('9508010138', '1995-08-01')).toBe(true)
  })

  it('reports a different date', () => {
    expect(egnMatchesDate('9508010139', '1995-08-02')).toBe(false)
    expect(egnMatchesDate('9508010139', '2095-08-01')).toBe(false) // century from the month
  })

  it('returns null when it cannot compare', () => {
    expect(egnMatchesDate('', '1995-08-01')).toBeNull()
    expect(egnMatchesDate('9508010139', null)).toBeNull()
    expect(egnMatchesDate('9513010130', '1995-13-01')).toBeNull() // month 13: no real date
    expect(egnMatchesDate('95080101', '1995-08-01')).toBeNull()   // too short
  })
})

describe('ЕГН vs MRZ date of birth', () => {
  it('flags an ЕГН whose date differs from the MRZ, even when front DOB = MRZ DOB', () => {
    const ocr: Record<string, any> = { personal_number: '9508020139', date_of_birth: '1995-08-01' }
    crossCheckBulgarianMrz(ocr, { date_of_birth: '1995-08-01' })
    expect(ocr.mrz_cross_check).toMatchObject({ date_of_birth: true, personal_number_vs_mrz_date_of_birth: false })
  })

  it('checks the MRZ ЕГН on its own when the front printed a different one', () => {
    const ocr: Record<string, any> = { personal_number: '9508020139', date_of_birth: '1995-08-01' }
    crossCheckBulgarianMrz(ocr, { date_of_birth: '1995-08-01', personal_number: '9508010139' })
    expect(ocr.mrz_cross_check).toMatchObject({
      personal_number: false,
      personal_number_vs_mrz_date_of_birth: false,
      mrz_personal_number_vs_mrz_date_of_birth: true,
    })
  })

  it('skips the MRZ-only check when both ЕГН are the same', () => {
    const ocr: Record<string, any> = { personal_number: '9508010139' }
    crossCheckBulgarianMrz(ocr, { date_of_birth: '1995-08-01', personal_number: '9508010139' })
    expect(ocr.mrz_cross_check.personal_number_vs_mrz_date_of_birth).toBe(true)
    expect(ocr.mrz_cross_check).not.toHaveProperty('mrz_personal_number_vs_mrz_date_of_birth')
  })

  it('compares an ЕГН taken from the MRZ with the front date of birth', () => {
    const ocr: Record<string, any> = { date_of_birth: '1995-08-02' }
    crossCheckBulgarianMrz(ocr, { date_of_birth: '1995-08-01', personal_number: '9508010139' })
    expect(ocr.personal_number).toBe('9508010139')
    expect(ocr.personal_number_matches_dob).toBe(false)
    expect(ocr.mrz_cross_check).toMatchObject({ date_of_birth: false, personal_number_vs_mrz_date_of_birth: true })
  })

  it('adds no ЕГН date check without a date of birth in the MRZ', () => {
    const ocr: Record<string, any> = { personal_number: '9508010139', surname_latin: 'PETROVA' }
    crossCheckBulgarianMrz(ocr, { last_name: 'PETROVA' })
    expect(ocr.mrz_cross_check).toEqual({ surname: true })
  })
})
