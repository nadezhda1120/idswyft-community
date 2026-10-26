/**
 * Log redaction. Removes identity data from structured log entries before they
 * are written, so logs never carry names, document or personal numbers, dates,
 * addresses, MRZ text, images or biometric vectors.
 *
 * Used by the backend and engine loggers when LOG_REDACT_PII=true (always on for
 * the stateless verification server). Field values are replaced by key name, and
 * free text everywhere is passed through the same patterns as the Sentry scrubber.
 * Pure and deterministic; the caller's nested objects are never mutated.
 */

import { PII_FIELDS, scrubText } from './sentryScrub.js';

export const REDACTED = '[redacted]';

/** Key fragments (snake_case or camelCase words) whose values are identity data. */
const PII_KEY_PART = /(?:^|_)(?:name|names|surname|patronymic|birth|dob|egn|lnch|personal_number|address|raw_lines|mrz_lines|raw_text|text|embedding|frame_base64|frames|screened_name|listed_name|ocr_fields|eye_color|height|buffer|base64)(?:_|$)/i;

/** "dateOfBirth" → "date_of_birth" so camelCase keys match the same rules. */
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function isPiiKey(key: string): boolean {
  const k = snake(key);
  return PII_FIELDS.has(k) || PII_KEY_PART.test(k);
}

const MAX_DEPTH = 8;

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return REDACTED;
  if (seen.has(value) || depth >= MAX_DEPTH) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1, seen));
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isPiiKey(key) ? REDACTED : redactValue(inner, depth + 1, seen);
  }
  return out;
}

/**
 * Redact a log entry in place at the top level (keeps logger internals such as
 * Symbol keys and `level`), with nested values replaced by redacted copies.
 */
export function redactLogEntry<T extends Record<string, unknown>>(entry: T, keep: ReadonlyArray<string> = ['level', 'timestamp', 'service', 'environment']): T {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(entry)) {
    if (keep.includes(key)) continue;
    (entry as Record<string, unknown>)[key] = key !== 'message' && isPiiKey(key)
      ? REDACTED
      : redactValue(entry[key], 0, seen);
  }
  return entry;
}
