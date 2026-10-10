/**
 * SQLite stores any value in any column; the declared type name only gives
 * an "affinity". The name is read the way SQLite itself reads it (substring
 * rules), and a few common names beyond SQLite's five affinities are
 * recognised too.
 */
import type { CanonicalType } from '@sethucms/core';

/** A canonical type plus whether the mapping lost information. */
export interface MappedType {
  type: CanonicalType;
  /** True when the declared type does not map cleanly. */
  lossy: boolean;
}

/**
 * Map a declared column type (e.g. "VARCHAR(20)") to a canonical type.
 *
 * Order matters: BOOL, JSON and DATE/DATETIME are checked before the INT and
 * CHAR substring rules, because names such as "BOOLEAN" or "DATETIME" would
 * otherwise be caught by a broader rule first. These names match what
 * sql-kit's DDL emits, so created tables read back as the same type.
 */
export function mapSqliteType(declared: string): MappedType {
  const t = declared.trim().toUpperCase();
  // No declared type means no affinity: values could be anything.
  if (t === '') {
    return { type: 'string', lossy: true };
  }
  if (t.includes('BOOL')) {
    return { type: 'boolean', lossy: false };
  }
  if (t.includes('JSON')) {
    return { type: 'json', lossy: false };
  }
  // Exact match only, so e.g. 'UPDATED' cannot be read as a date.
  if (t === 'DATE') {
    return { type: 'date', lossy: false };
  }
  if (t.includes('DATETIME') || t.includes('TIMESTAMP')) {
    return { type: 'datetime', lossy: false };
  }
  // SQLite's own rule: any name containing INT has INTEGER affinity.
  if (t.includes('INT')) {
    return { type: 'integer', lossy: false };
  }
  // TEXT affinity is CHAR, CLOB or TEXT; plain TEXT is the long form here.
  if (t === 'TEXT' || t.includes('CLOB')) {
    return { type: 'text', lossy: false };
  }
  if (t.includes('CHAR')) {
    return { type: 'string', lossy: false };
  }
  if (t.includes('BLOB')) {
    return { type: 'binary', lossy: false };
    // REAL/NUMERIC affinities, plus DECIMAL which SQLite files with NUMERIC.
  }
  if (
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('NUMERIC') ||
    t.includes('DECIMAL')
  ) {
    return { type: 'decimal', lossy: false };
  }
  // Unknown names are shown as text but flagged, rather than guessed at.
  return { type: 'string', lossy: true };
}
