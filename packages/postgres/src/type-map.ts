/**
 * Mapping PostgreSQL column types onto SethuCMS canonical types.
 * Types we cannot map exactly fall back to "string" and are marked `lossy`,
 * so the admin can warn the editor instead of hiding the mismatch.
 */
import type { CanonicalType } from '@sethucms/core';

/** A canonical type plus whether the mapping lost information. */
export interface MappedType {
  type: CanonicalType;
  /** True when the native type does not map cleanly. */
  lossy: boolean;
}

// Keyed by information_schema.columns.data_type (the long type names, e.g.
// "character varying", not "varchar"). Every entry is a clean mapping, but
// note the widening: all integer widths become one canonical `integer`, and
// all floating/numeric types become `decimal`. Arrays surface only as the
// generic "ARRAY" because data_type does not reveal the element type.
const EXACT: Record<string, CanonicalType> = {
  smallint: 'integer',
  integer: 'integer',
  bigint: 'integer',
  numeric: 'decimal',
  real: 'decimal',
  'double precision': 'decimal',
  boolean: 'boolean',
  text: 'text',
  'character varying': 'string',
  character: 'string',
  uuid: 'string',
  citext: 'string',
  date: 'date',
  'timestamp with time zone': 'datetime',
  'timestamp without time zone': 'datetime',
  json: 'json',
  jsonb: 'json',
  ARRAY: 'array',
  bytea: 'binary',
};

/**
 * Map a Postgres `data_type` to a canonical type. `dataType` is the value of
 * information_schema.columns.data_type. Anything not listed (enums, intervals,
 * geometric types, ...) becomes a lossy "string" so it stays readable.
 */
export function mapPgType(dataType: string): MappedType {
  // hasOwn guards against names like "constructor" resolving via the prototype.
  const exact = Object.hasOwn(EXACT, dataType) ? EXACT[dataType] : undefined;
  if (exact) {
    return { type: exact, lossy: false };
  }
  return { type: 'string', lossy: true };
}
