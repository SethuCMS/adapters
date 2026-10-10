/**
 * Creating a table from a collection definition.
 *
 * Used only by migration, when an administrator asked for missing collections
 * to be created. The result is a plain table: columns, a primary key, NOT NULL
 * where a value is required, and foreign keys to collections that exist.
 * Validation rules (min, max, pattern, enum) are NOT turned into database
 * constraints; the CMS still enforces them when records are written through it.
 */
import {
  errors,
  primaryKeyOf,
  referencedCollection,
  type CanonicalType,
  type CollectionDefinition,
  type FieldDefinition,
} from '@sethucms/core';
import type { Dialect } from './dialect.js';
import { tableOf, type CompiledSql } from './builders.js';

/** A concrete SQL column type chosen for a canonical type. */
export interface ColumnType {
  sql: string;
  /**
   * The database cannot store this canonical type exactly (it is read back
   * as another type).
   */
  approximate: boolean;
}

// Used when a string field has no maxLength validation.
const DEFAULT_STRING_LENGTH = 255;

/**
 * Pick the SQL column type for a canonical type in the given dialect.
 *
 * `effective` is the type after reference resolution (see effectiveType), not
 * necessarily `field.type`. Varchar length comes from the field's maxLength,
 * clamped to what the database allows.
 */
export function columnType(
  dialect: Dialect,
  field: FieldDefinition,
  effective: CanonicalType,
): ColumnType {
  // MySQL limits row size and index length, so cap varchar lower there;
  // Postgres allows up to 10,485,760 characters.
  const length = Math.min(
    Math.max(field.validation?.maxLength ?? DEFAULT_STRING_LENGTH, 1),
    dialect.name === 'mysql' ? 1000 : 10_485_760,
  );
  switch (dialect.name) {
    case 'postgres':
      return pgType(effective, length);
    case 'mysql':
      return mysqlType(effective, length);
    case 'sqlite':
      return sqliteType(effective, length);
  }
}

// Postgres mapping. jsonb stands in for array and geopoint, which is lossy:
// they read back as plain json (hence approximate: true).
function pgType(type: CanonicalType, length: number): ColumnType {
  switch (type) {
    case 'string':
      return { sql: `varchar(${length})`, approximate: false };
    case 'text':
      return { sql: 'text', approximate: false };
    case 'integer':
      // bigint, so ids and counters beyond 32 bits fit.
      return { sql: 'bigint', approximate: false };
    case 'decimal':
      // Unbounded numeric avoids silently rounding decimals.
      return { sql: 'numeric', approximate: false };
    case 'boolean':
      return { sql: 'boolean', approximate: false };
    case 'datetime':
      return { sql: 'timestamptz', approximate: false };
    case 'date':
      return { sql: 'date', approximate: false };
    case 'json':
      return { sql: 'jsonb', approximate: false };
    case 'array':
      return { sql: 'jsonb', approximate: true };
    case 'binary':
      return { sql: 'bytea', approximate: false };
    case 'geopoint':
      return { sql: 'jsonb', approximate: true };
    case 'reference':
      return { sql: 'text', approximate: false };
  }
}

// MySQL mapping. There is no native bool, array or point, so those use
// tinyint(1) or JSON; the JSON stand-ins are lossy (approximate: true).
function mysqlType(type: CanonicalType, length: number): ColumnType {
  switch (type) {
    case 'string':
      return { sql: `varchar(${length})`, approximate: false };
    case 'text':
      return { sql: 'longtext', approximate: false };
    case 'integer':
      return { sql: 'bigint', approximate: false };
    case 'decimal':
      // 38 digits is MySQL's maximum; the fixed 10 decimals can round.
      return { sql: 'decimal(38,10)', approximate: false };
    case 'boolean':
      return { sql: 'tinyint(1)', approximate: false };
    case 'datetime':
      // Microsecond precision: more than JS timestamps (ms) need.
      return { sql: 'datetime(6)', approximate: false };
    case 'date':
      return { sql: 'date', approximate: false };
    case 'json':
      return { sql: 'json', approximate: false };
    case 'array':
      return { sql: 'json', approximate: true };
    case 'binary':
      return { sql: 'longblob', approximate: false };
    case 'geopoint':
      return { sql: 'json', approximate: true };
    case 'reference':
      // Keys must stay indexable, so reference columns are capped at 255.
      return { sql: `varchar(${Math.min(length, 255)})`, approximate: false };
  }
}

// SQLite keeps whatever type name you declare, so the names below are chosen
// to be read back as the same canonical type (see sqlite introspection).
function sqliteType(type: CanonicalType, length: number): ColumnType {
  switch (type) {
    case 'string':
      return { sql: `VARCHAR(${length})`, approximate: false };
    case 'text':
      return { sql: 'TEXT', approximate: false };
    case 'integer':
      return { sql: 'INTEGER', approximate: false };
    case 'decimal':
      // NUMERIC affinity; SQLite has no exact decimal, so values may be floats.
      return { sql: 'NUMERIC', approximate: false };
    case 'boolean':
      return { sql: 'BOOLEAN', approximate: false };
    case 'datetime':
      return { sql: 'DATETIME', approximate: false };
    case 'date':
      return { sql: 'DATE', approximate: false };
    case 'json':
      return { sql: 'JSON', approximate: false };
    case 'array':
      return { sql: 'JSON', approximate: true };
    case 'binary':
      return { sql: 'BLOB', approximate: false };
    case 'geopoint':
      return { sql: 'JSON', approximate: true };
    case 'reference':
      return { sql: 'TEXT', approximate: false };
  }
}

/** Inputs for buildCreateTable. */
export interface CreateTableOptions {
  schema: string | undefined;
  collection: CollectionDefinition;
  /**
   * Every collection being created or already there, to find the key type
   * of referenced collections.
   */
  all: ReadonlyMap<string, CollectionDefinition>;
  /**
   * Names of collections whose tables exist when this one is created.
   * Foreign keys are added only to those.
   */
  existing: ReadonlySet<string>;
}

/**
 * What the type of a column will be: references take the type of the key
 * they point at. Otherwise a FOREIGN KEY would fail on mismatched types.
 */
function effectiveType(
  options: CreateTableOptions,
  field: FieldDefinition,
): CanonicalType {
  const target = referencedCollection(options.collection, field, options.all);
  const other = target ? options.all.get(target) : undefined;
  if (
    other &&
    (field.type === 'reference' ||
      field.type === 'string' ||
      field.type === 'integer')
  ) {
    return primaryKeyOf(other).type;
  }
  return field.type;
}

/**
 * Build the CREATE TABLE statement for one collection.
 *
 * Returns the statements to run and human-readable warnings for columns that
 * the database can only store approximately. Identifiers are quoted through
 * the dialect, so only validated names reach the SQL text.
 */
export function buildCreateTable(
  dialect: Dialect,
  options: CreateTableOptions,
): { statements: CompiledSql[]; warnings: string[] } {
  const { collection, schema } = options;
  const key = primaryKeyOf(collection);
  if (!collection.fields.some((field) => field.name === key.name)) {
    throw errors.internal('Collection has no primary key');
  }

  const q = dialect.quote;
  const warnings: string[] = [];
  const lines: string[] = [];
  const constraints: string[] = [];

  for (const field of collection.fields) {
    const effective = effectiveType(options, field);
    const type = columnType(dialect, field, effective);
    if (type.approximate) {
      warnings.push(
        `"${field.name}" (${field.type}) is stored as ${type.sql} in ${dialect.name} and reads back as json`,
      );
    }

    if (field.name === key.name) {
      // Auto-increment applies only to integer keys; other keys are supplied.
      const generated = field.generated === true && effective === 'integer';
      lines.push(keyColumn(dialect, q(field.name), type.sql, generated));
      // MySQL declares the primary key as a separate table constraint.
      if (dialect.name === 'mysql') {
        constraints.push(`PRIMARY KEY (${q(field.name)})`);
      }
      continue;
    }
    // Generated (database-filled) values must stay nullable on insert.
    const notNull =
      field.required === true && field.generated !== true ? ' NOT NULL' : '';
    lines.push(`${q(field.name)} ${type.sql}${notNull}`);
  }

  for (const field of collection.fields) {
    if (field.name === key.name) {
      continue;
    }
    // Foreign keys only to tables that already exist at this point; the rest
    // are skipped to keep creation order-independent and avoid failures.
    const target = referencedCollection(collection, field, options.all);
    const other = target ? options.all.get(target) : undefined;
    if (!target || !other || !options.existing.has(target)) {
      continue;
    }
    const foreign = `FOREIGN KEY (${q(field.name)}) REFERENCES ${tableOf(dialect, { schema, collection: other })} (${q(primaryKeyOf(other).name)})`;
    constraints.push(foreign);
  }

  const body = [...lines, ...constraints].join(',\n  ');
  // InnoDB is needed for foreign keys; utf8mb4 for full Unicode.
  const tail =
    dialect.name === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  return {
    statements: [
      {
        text: `CREATE TABLE ${tableOf(dialect, { schema, collection })} (\n  ${body}\n)${tail}`,
        values: [],
      },
    ],
    warnings,
  };
}

// The primary key column definition, which differs per database.
function keyColumn(
  dialect: Dialect,
  column: string,
  type: string,
  generated: boolean,
): string {
  switch (dialect.name) {
    case 'postgres':
      // BY DEFAULT (not ALWAYS) so a migration can keep the original ids.
      return generated
        ? `${column} bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`
        : `${column} ${type} PRIMARY KEY`;
    case 'mysql':
      return generated
        ? `${column} bigint NOT NULL AUTO_INCREMENT`
        : `${column} ${type} NOT NULL`;
    case 'sqlite':
      // Only exactly "INTEGER PRIMARY KEY" becomes the row id; AUTOINCREMENT
      // keeps ids from being reused.
      return generated
        ? `${column} INTEGER PRIMARY KEY AUTOINCREMENT`
        : `${column} ${type} PRIMARY KEY`;
  }
}
