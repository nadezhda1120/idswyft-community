import { describe, it, expect } from 'vitest'
import { redactLogEntry, isPiiKey, REDACTED } from './logRedact.js'

// SYNTHETIC values only.

describe('isPiiKey', () => {
  it('matches identity keys in snake_case and camelCase', () => {
    for (const k of ['full_name', 'surname_cyrillic', 'given_name_latin', 'dateOfBirth', 'personal_number',
      'documentNumber', 'raw_text', 'raw_lines', 'face_embedding', 'frame_base64', 'address', 'ocr_fields', 'egn']) {
      expect(isPiiKey(k), k).toBe(true)
    }
  })

  it('keeps operational keys', () => {
    for (const k of ['elapsedMs', 'lineCount', 'frameCount', 'status', 'provider', 'issuingCountry', 'confidence', 'hasMrz', 'flow']) {
      expect(isPiiKey(k), k).toBe(false)
    }
  })
})

describe('redactLogEntry', () => {
  it('redacts nested identity values and free text, keeps the rest', () => {
    const entry: Record<string, unknown> = {
      level: 'info',
      timestamp: '2026-10-26T10:00:00.000Z',
      message: 'Gate 1 for 9508010139 born 1995-08-01',
      ocr_fields: { full_name: 'IVANOVA', id_number: 'AA1234567' },
      result: { surname_latin: 'IVANOVA', score: 0.91, note: 'number AA1234567' },
      elapsedMs: 120,
    }
    redactLogEntry(entry)
    expect(entry).toEqual({
      level: 'info',
      timestamp: '2026-10-26T10:00:00.000Z',
      message: 'Gate 1 for [id] born [date]',
      ocr_fields: REDACTED,
      result: { surname_latin: REDACTED, score: 0.91, note: 'number [id]' },
      elapsedMs: 120,
    })
  })

  it('does not mutate the caller\'s nested objects', () => {
    const meta = { full_name: 'IVANOVA' }
    const entry: Record<string, unknown> = { message: 'x', meta }
    redactLogEntry(entry)
    expect(meta.full_name).toBe('IVANOVA')
    expect(entry.meta).toEqual({ full_name: REDACTED })
  })

  it('replaces buffers and handles errors and cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const entry: Record<string, unknown> = {
      message: 'x', image: Buffer.from('jpeg'), error: new Error('bad id AA1234567'), cyclic,
    }
    redactLogEntry(entry)
    expect(entry.image).toBe(REDACTED)
    expect(entry.error).toEqual({ name: 'Error', message: 'bad id [id]' })
    expect(entry.cyclic).toEqual({ a: 1, self: REDACTED })
  })
})
