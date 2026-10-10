/**
 * Mapping MySQL / MariaDB column types onto SethuCMS canonical types.
 * Types we cannot map exactly fall back to a lossy "string", so the admin
 * can warn the editor instead of hiding the mismatch.
 */
import type { CanonicalType } from '@sethucms/core';

/** A canonical type plus whether the mapping lost information. */
export interface MappedType {
  type: CanonicalType;
  /** True when the native type does not map cleanly. */
  lossy: boolean;
}

/**
 * Map a column to a canonical type. `dataType` is information_schema's
 * DATA_TYPE; `columnType` is COLUMN_TYPE (for example "tinyint(1)").
 */
export function mapMysqlType(dataType: string, columnType: string): MappedType {
  const t = dataType.toLowerCase();
  // MySQL has no boolean: BOOLEAN is an alias for tinyint(1), so the display
  // width is the only hint. Other tinyint widths stay integers.
  if (t === 'tinyint' && /^tinyint\(1\)/i.test(columnType)) {
    return { type: 'boolean', lossy: false };
  }
  if (
    [
      'tinyint',
      'smallint',
      'mediumint',
      'int',
      'integer',
      'bigint',
      'year',
    ].includes(t)
  ) {
    return { type: 'integer', lossy: false };
  }
  // All numeric/floating types share one canonical decimal.
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(t)) {
    return { type: 'decimal', lossy: false };
  }
  if (['varchar', 'char'].includes(t)) {
    return { type: 'string', lossy: false };
  }
  if (['tinytext', 'text', 'mediumtext', 'longtext'].includes(t)) {
    return { type: 'text', lossy: false };
  }
  // Native JSON (MySQL). MariaDB's JSON is LONGTEXT; see introspect.ts.
  if (t === 'json') {
    return { type: 'json', lossy: false };
  }
  if (t === 'date') {
    return { type: 'date', lossy: false };
  }
  // TIMESTAMP is stored in UTC and DATETIME is not; both read as datetime.
  if (['datetime', 'timestamp'].includes(t)) {
    return { type: 'datetime', lossy: false };
  }
  if (
    [
      'tinyblob',
      'blob',
      'mediumblob',
      'longblob',
      'binary',
      'varbinary',
    ].includes(t)
  ) {
    return { type: 'binary', lossy: false };
  }
  // ENUM values are strings; the allowed set is not carried over.
  if (t === 'enum') {
    return { type: 'string', lossy: false };
  }
  // Everything else (set, time, bit, geometry, ...) is shown as text.
  return { type: 'string', lossy: true };
}
