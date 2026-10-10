/**
 * Turning database rows into plain records with canonical values.
 *
 * Drivers return some types in awkward forms (bigint as a string, timestamps
 * as Date objects). Normalising here means the rest of the platform sees one
 * shape.
 */
import type { CollectionDefinition } from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';

// Date-only columns are shown as YYYY-MM-DD.
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Convert one raw `pg` value to the canonical value for a field type. */
function normalizeValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return type === 'date' ? toIsoDate(value) : value.toISOString();
  }

  // `pg` returns bigint as text. Convert only when the number is exact.
  if (
    type === 'integer' &&
    typeof value === 'string' &&
    /^-?\d+$/.test(value)
  ) {
    const asNumber = Number(value);
    // Keep very large numbers as text rather than silently losing digits.
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  // bytea arrives as bytes; records carry binary as base64 text.
  if (type === 'binary' && value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return value;
}

/**
 * Convert a raw row into a portable record, keeping only the collection's
 * own fields (and only those present in the row, e.g. under a projection).
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
