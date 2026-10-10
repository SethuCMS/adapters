/**
 * Turning database rows into plain records with canonical values.
 *
 * Drivers return some types in awkward forms (bigint as text, timestamps as
 * Date objects, booleans as 0 and 1, JSON as text). Normalising here means the
 * rest of the platform sees one shape whichever database it came from.
 */
import type { CollectionDefinition } from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';

// Date-only columns are shown as YYYY-MM-DD. Slicing the UTC ISO string
// assumes the driver built the Date at UTC midnight (no local-time shift).
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// Some drivers hand JSON back as text. Unparseable text is returned untouched
// instead of throwing, so one bad cell cannot fail a whole page of rows.
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Convert one raw driver value to the canonical value for a field type.
 * Unknown combinations pass through unchanged. NULL/undefined become null.
 */
function normalizeValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return type === 'date' ? toIsoDate(value) : value.toISOString();
  }

  if (typeof value === 'bigint') {
    // BIGINT: use a plain number only when it round-trips exactly; beyond
    // 2^53 a number would silently lose digits, so fall back to text.
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (
    type === 'integer' &&
    typeof value === 'string' &&
    /^-?\d+$/.test(value)
  ) {
    const asNumber = Number(value);
    // Keep very large numbers as text rather than silently losing digits.
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  // MySQL and SQLite have no real boolean and return 0/1.
  if (type === 'boolean' && (value === 0 || value === 1)) {
    return value === 1;
  }
  // JSON-ish columns can arrive as text (MySQL, SQLite), so parse them.
  if (
    (type === 'json' || type === 'array' || type === 'geopoint') &&
    typeof value === 'string'
  ) {
    return parseJson(value);
  }
  // Binary is exposed to the portable record format as base64 text.
  if (type === 'binary' && value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return value;
}

/**
 * Convert a raw database row into a portable record.
 *
 * Only columns that belong to the collection are copied, so extra columns
 * (for example joins or driver metadata) never leak into records. Columns
 * absent from the row stay absent (a projection may have skipped them).
 */
export function normalizeRow(
  collection: CollectionDefinition,
  row: Record<string, unknown>,
): RecordData {
  const record: RecordData = {};
  for (const field of collection.fields) {
    if (Object.hasOwn(row, field.name)) {
      record[field.name] = normalizeValue(field.type, row[field.name]);
    }
  }
  return record;
}
