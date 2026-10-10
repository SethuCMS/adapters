/**
 * What differs between SQL databases, in one place.
 *
 * Everything else (how filters, paging, inserts and table creation are built)
 * is shared, so a safety fix in one place protects every SQL adapter.
 */
import { errors } from '@sethucms/core';

/**
 * The per-database switches and snippets that the shared builders consult.
 * Each member exists because the three databases really do disagree on it.
 */
export interface Dialect {
  readonly name: 'postgres' | 'mysql' | 'sqlite';
  /**
   * Quote a table, column or schema name. Refuses anything that is not a
   * plain identifier.
   */
  quote(name: string): string;
  /** The n-th parameter placeholder, counting from 1. */
  placeholder(n: number): string;
  /**
   * `ILIKE` where the database has it; otherwise `LIKE` (case-insensitive
   * by the database's default).
   */
  readonly likeOperator: 'ILIKE' | 'LIKE';
  /**
   * The ESCAPE clause that makes backslash the escape character in LIKE
   * patterns.
   */
  readonly likeEscape: string;
  /**
   * Null-safe "not equal": true when the column is NULL and the value is
   * not.
   */
  notEqual(column: string, placeholder: string): string;
  /** Does this array (stored as JSON or natively) contain the value? */
  arrayContains(
    column: string,
    placeholder: string,
    value: unknown,
  ): { text: string; param: unknown };
  /**
   * Does the database accept `NULLS FIRST/LAST`? Where not, NULLs already
   * sort as the smallest value.
   */
  readonly nullsOrdering: boolean;
  /** Does INSERT/UPDATE/DELETE support RETURNING? */
  readonly returning: boolean;
  /**
   * Write LIMIT and OFFSET into the SQL text (as checked integers) instead
   * of as parameters. Needed where prepared statements reject numeric
   * LIMIT parameters.
   */
  readonly inlineLimits: boolean;
  /** Arrays are stored as JSON text (true) or as native arrays (false). */
  readonly arrayAsJson: boolean;
  /** SQL for inserting a row made only of defaults. */
  insertDefaults(table: string): string;
  /** Convert an ISO date-time string to the form the driver wants. */
  datetimeParam(value: string): unknown;
  /** Convert a boolean to what the driver wants for a parameter. */
  booleanParam(value: boolean): unknown;
}

// Identifiers cannot be bound as parameters, so they are whitelisted instead:
// a letter or underscore, then letters/digits/underscores, at most 63 chars
// (Postgres' limit). Nothing that could close a quote or start a comment
// can match, which makes quoting below injection-proof.
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

// Validate an identifier; throws rather than trying to escape a bad one.
function check(name: string): string {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw errors.internal('Refused to use an unsafe identifier');
  }
  return name;
}

/** PostgreSQL: numbered `$n` parameters, RETURNING, native arrays. */
export const postgresDialect: Dialect = {
  name: 'postgres',
  quote: (name) => `"${check(name)}"`,
  placeholder: (n) => `$${n}`,
  likeOperator: 'ILIKE',
  likeEscape: "ESCAPE '\\'",
  notEqual: (column, placeholder) =>
    `${column} IS DISTINCT FROM ${placeholder}`,
  arrayContains: (column, placeholder, value) => ({
    text: `${placeholder} = ANY(${column})`,
    param: value,
  }),
  nullsOrdering: true,
  returning: true,
  inlineLimits: false,
  arrayAsJson: false,
  insertDefaults: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  datetimeParam: (value) => value,
  booleanParam: (value) => value,
};

/**
 * MySQL / MariaDB: positional `?`, no RETURNING (the key comes from
 * insertId), and arrays stored as JSON.
 */
export const mysqlDialect: Dialect = {
  name: 'mysql',
  quote: (name) => `\`${check(name)}\``,
  placeholder: () => '?',
  likeOperator: 'LIKE',
  // Inside a MySQL string literal a backslash must itself be escaped.
  likeEscape: "ESCAPE '\\\\'",
  // `<=>` is MySQL's null-safe equality; plain `<>` yields NULL for NULLs.
  notEqual: (column, placeholder) => `NOT (${column} <=> ${placeholder})`,
  arrayContains: (column, placeholder, value) => ({
    text: `JSON_CONTAINS(${column}, ${placeholder})`,
    param: JSON.stringify(value),
  }),
  nullsOrdering: false,
  returning: false,
  inlineLimits: true,
  arrayAsJson: true,
  insertDefaults: (table) => `INSERT INTO ${table} () VALUES ()`,
  // MySQL DATETIME does not take ISO "T...Z" text reliably, so hand the
  // driver a Date and let it format the value.
  datetimeParam: (value) => new Date(value),
  booleanParam: (value) => (value ? 1 : 0),
};

/**
 * SQLite: positional `?`, RETURNING (3.35+), arrays stored as JSON text and
 * queried through the json_each table-valued function.
 */
export const sqliteDialect: Dialect = {
  name: 'sqlite',
  quote: (name) => `"${check(name)}"`,
  placeholder: () => '?',
  likeOperator: 'LIKE',
  likeEscape: "ESCAPE '\\'",
  // `IS NOT` is SQLite's null-safe inequality.
  notEqual: (column, placeholder) => `${column} IS NOT ${placeholder}`,
  arrayContains: (column, placeholder, value) => ({
    // json_each expands the JSON text into rows we can compare against.
    text: `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${placeholder})`,
    param: value,
  }),
  nullsOrdering: false,
  returning: true,
  inlineLimits: false,
  arrayAsJson: true,
  insertDefaults: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  datetimeParam: (value) => value,
  booleanParam: (value) => (value ? 1 : 0),
};
