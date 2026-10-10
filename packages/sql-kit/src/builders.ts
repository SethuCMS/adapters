/**
 * Building SQL from portable queries, for any dialect.
 *
 * Two rules keep this safe:
 *
 *  1. Values NEVER go into the SQL text. They become parameters that the
 *     database receives separately.
 *  2. Names (tables, columns) come only from the collection definition, are
 *     checked against a strict pattern, and are quoted.
 *
 * The functions here are pure: same input, same output, no database needed.
 */
import {
  errors,
  primaryKeyOf,
  type CollectionDefinition,
  type Filter,
  type Query,
} from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';
import type { Dialect } from './dialect.js';

/** A statement ready to send: SQL text plus its bound parameter values. */
export interface CompiledSql {
  text: string;
  values: unknown[];
}

/**
 * Escape LIKE wildcards so user text is matched literally. Pairs with the
 * dialect's ESCAPE clause, which makes backslash the escape character.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Where a collection lives: an optional schema plus its definition. */
export interface Target {
  /**
   * Schema or database name, or undefined for databases without schemas
   * (SQLite).
   */
  schema: string | undefined;
  collection: CollectionDefinition;
}

/**
 * The quoted, optionally schema-qualified table name for a collection.
 * `nativeName` lets a collection map onto a table with a different name.
 */
export function tableOf(
  dialect: Dialect,
  { schema, collection }: Target,
): string {
  const table = dialect.quote(collection.nativeName ?? collection.name);
  return schema === undefined ? table : `${dialect.quote(schema)}.${table}`;
}

// Resolve a field to its quoted column. Checking against the collection's
// own fields first means a caller-supplied name can never reach the SQL
// unless the model declares it (defence in depth beside dialect.quote).
function columnOf(
  dialect: Dialect,
  collection: CollectionDefinition,
  field: string,
): string {
  if (!collection.fields.some((candidate) => candidate.name === field)) {
    throw errors.validation('Unknown field');
  }
  return dialect.quote(field);
}

/**
 * A checked non-negative integer, safe to write into SQL text. Only used
 * where the driver cannot bind LIMIT/OFFSET as parameters (MySQL).
 */
function inlineInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errors.internal('Refused to use an unsafe number');
  }
  return String(value);
}

/**
 * Collects parameter values and hands out their placeholders. Placeholder
 * numbering follows insertion order, which `$n` dialects rely on.
 */
class Params {
  readonly values: unknown[] = [];
  constructor(private readonly dialect: Dialect) {}
  add(value: unknown): string {
    this.values.push(value);
    return this.dialect.placeholder(this.values.length);
  }
}

/**
 * Turn a value from the portable record format into what the driver should
 * receive for this field.
 *
 * Structured values are serialised to JSON text; booleans, datetimes and
 * binary are adapted per dialect. null/undefined always bind as NULL.
 */
export function toParameter(
  dialect: Dialect,
  collection: CollectionDefinition,
  field: string,
  value: unknown,
): unknown {
  const type = collection.fields.find(
    (candidate) => candidate.name === field,
  )?.type;
  if (value === null || value === undefined) {
    return null;
  }
  switch (type) {
    case 'json':
      return JSON.stringify(value);
    case 'array':
      // Postgres binds a JS array natively; the others store JSON text.
      return dialect.arrayAsJson ? JSON.stringify(value) : value;
    case 'geopoint':
      return JSON.stringify(value);
    case 'boolean':
      return typeof value === 'boolean' ? dialect.booleanParam(value) : value;
    case 'datetime':
      return typeof value === 'string' ? dialect.datetimeParam(value) : value;
    // Binary travels as base64 text in records; decode to bytes for the driver.
    case 'binary':
      return typeof value === 'string' ? Buffer.from(value, 'base64') : value;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// Compile a filter tree to a boolean SQL expression, pushing every value
// into `params` instead of the text. Recursion mirrors and/or/not nesting.
function compileFilter(
  dialect: Dialect,
  filter: Filter,
  collection: CollectionDefinition,
  params: Params,
): string {
  if ('and' in filter) {
    return `(${filter.and.map((child) => compileFilter(dialect, child, collection, params)).join(' AND ')})`;
  }
  if ('or' in filter) {
    return `(${filter.or.map((child) => compileFilter(dialect, child, collection, params)).join(' OR ')})`;
  }
  // NOT of NULL is NULL, which would drop the row. COALESCE to FALSE so an
  // unknown result under NOT counts as "matches", like the other adapters.
  if ('not' in filter) {
    return `(NOT COALESCE(${compileFilter(dialect, filter.not, collection, params)}, FALSE))`;
  }

  const column = columnOf(dialect, collection, filter.field);
  const field = collection.fields.find(
    (candidate) => candidate.name === filter.field,
  )!;
  const value = filter.value;
  const param = (raw: unknown) =>
    params.add(toParameter(dialect, collection, filter.field, raw));

  switch (filter.op) {
    case 'eq':
      return value === null
        ? `${column} IS NULL`
        : `${column} = ${param(value)}`;
    // SQL `<>` is never true against NULL, so the dialect supplies a
    // null-safe form.
    case 'ne':
      return value === null
        ? `${column} IS NOT NULL`
        : dialect.notEqual(column, param(value));
    case 'lt':
      return `${column} < ${param(value)}`;
    case 'lte':
      return `${column} <= ${param(value)}`;
    case 'gt':
      return `${column} > ${param(value)}`;
    case 'gte':
      return `${column} >= ${param(value)}`;
    // Lists are expanded into one placeholder per item; see compileList.
    case 'in':
    case 'nin':
      return compileList(
        dialect,
        filter.op,
        column,
        value as unknown[],
        params,
        (item) => toParameter(dialect, collection, filter.field, item),
      );
    case 'contains': {
      // The placeholder is computed by hand because arrayContains may need to
      // transform the bound value (MySQL wants JSON text) before it is bound.
      if (field.type === 'array') {
        const built = dialect.arrayContains(
          column,
          dialect.placeholder(params.values.length + 1),
          value,
        );
        params.values.push(built.param);
        return built.text;
      }
      // User text is escaped so '%' and '_' match literally, then wrapped.
      return `${column} ${dialect.likeOperator} ${params.add(`%${escapeLike(String(value))}%`)} ${dialect.likeEscape}`;
    }
    case 'startsWith':
      return `${column} ${dialect.likeOperator} ${params.add(`${escapeLike(String(value))}%`)} ${dialect.likeEscape}`;
    case 'exists':
      return value === false ? `${column} IS NULL` : `${column} IS NOT NULL`;
  }
}

/**
 * IN and NOT IN, with null handled separately because `x IN (NULL)` is never
 * true in SQL (and `x NOT IN (..., NULL)` is never true either).
 */
function compileList(
  dialect: Dialect,
  op: 'in' | 'nin',
  column: string,
  list: unknown[],
  params: Params,
  convert: (item: unknown) => unknown,
): string {
  // Split NULL out of the list and test it with IS NULL instead.
  const hasNull = list.includes(null);
  const concrete = list.filter((item) => item !== null);
  const placeholders = concrete
    .map((item) => params.add(convert(item)))
    .join(', ');

  if (op === 'in') {
    // Only NULLs were listed: `IN ()` is invalid SQL, so test NULL directly.
    if (concrete.length === 0) {
      return `${column} IS NULL`;
    }
    return hasNull
      ? `(${column} IN (${placeholders}) OR ${column} IS NULL)`
      : `${column} IN (${placeholders})`;
  }

  if (concrete.length === 0) {
    return `${column} IS NOT NULL`;
  }
  return hasNull
    ? `(${column} IS NOT NULL AND ${column} NOT IN (${placeholders}))`
    : `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * The comma-separated, quoted column list. Defaults to every field; an
 * explicit projection is validated against the collection's fields.
 */
export function selectList(
  dialect: Dialect,
  collection: CollectionDefinition,
  projection?: string[],
): string {
  const names = projection ?? collection.fields.map((field) => field.name);
  return names.map((name) => columnOf(dialect, collection, name)).join(', ');
}

/**
 * List records. Fetches one extra row so the adapter can tell whether another
 * page exists without a second query.
 */
export function buildSelect(
  dialect: Dialect,
  target: Target,
  query: Query,
  offset: number,
): CompiledSql {
  const { collection } = target;
  const params = new Params(dialect);
  const where = query.filter
    ? ` WHERE ${compileFilter(dialect, query.filter, collection, params)}`
    : '';

  // Sort by the caller's fields, then by the primary key so pages never
  // overlap or skip (ties would otherwise order arbitrarily).
  const keyName = primaryKeyOf(collection).name;
  const sorts = [...(query.sort ?? [])];
  if (!sorts.some((sort) => sort.field === keyName)) {
    sorts.push({ field: keyName, dir: 'asc' });
  }
  // Make NULL ordering consistent: NULLs first when ascending, last when
  // descending (i.e. NULL acts as the smallest value). Databases without
  // NULLS FIRST/LAST already sort this way.
  const orderBy = sorts
    .map((sort) => {
      const column = columnOf(dialect, collection, sort.field);
      if (dialect.nullsOrdering) {
        return `${column} ${sort.dir === 'asc' ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`;
      }
      return `${column} ${sort.dir === 'asc' ? 'ASC' : 'DESC'}`;
    })
    .join(', ');

  // limit+1 rows are fetched so the caller can detect a next page. Values
  // are inlined only after inlineInteger validates them.
  const limit = dialect.inlineLimits
    ? inlineInteger(query.page.limit + 1)
    : params.add(query.page.limit + 1);
  const skip = dialect.inlineLimits
    ? inlineInteger(offset)
    : params.add(offset);
  const text = `SELECT ${selectList(dialect, collection, query.projection)} FROM ${tableOf(dialect, target)}${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${skip}`;
  return { text, values: params.values };
}

/** SELECT one record by primary key. The id is bound, never inlined. */
export function buildGet(
  dialect: Dialect,
  target: Target,
  id: string,
): CompiledSql {
  const { collection } = target;
  const key = columnOf(dialect, collection, primaryKeyOf(collection).name);
  return {
    text: `SELECT ${selectList(dialect, collection)} FROM ${tableOf(dialect, target)} WHERE ${key} = ${dialect.placeholder(1)}`,
    values: [id],
  };
}

/**
 * INSERT one record. Only declared columns are written; the returned row
 * comes from RETURNING where supported (otherwise the adapter re-reads it).
 */
export function buildInsert(
  dialect: Dialect,
  target: Target,
  values: RecordData,
): CompiledSql {
  const { collection } = target;
  const params = new Params(dialect);

  // Nulls are left out so the column default (or NULL) applies.
  const entries = Object.entries(values).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  const returning = dialect.returning
    ? ` RETURNING ${selectList(dialect, collection)}`
    : '';

  // No values at all: some databases reject `VALUES ()`, so ask the dialect.
  if (entries.length === 0) {
    return {
      text: `${dialect.insertDefaults(tableOf(dialect, target))}${returning}`,
      values: [],
    };
  }

  const columns = entries
    .map(([name]) => columnOf(dialect, collection, name))
    .join(', ');
  const placeholders = entries
    .map(([name, value]) =>
      params.add(toParameter(dialect, collection, name, value)),
    )
    .join(', ');
  return {
    text: `INSERT INTO ${tableOf(dialect, target)} (${columns}) VALUES (${placeholders})${returning}`,
    values: params.values,
  };
}

/**
 * UPDATE one record by primary key. An explicit null sets the column to
 * NULL; keys absent from `values` are left unchanged (a partial update).
 */
export function buildUpdate(
  dialect: Dialect,
  target: Target,
  id: string,
  values: RecordData,
): CompiledSql {
  const { collection } = target;
  if (Object.keys(values).length === 0) {
    throw errors.validation('Nothing to update');
  }

  const params = new Params(dialect);
  const assignments = Object.entries(values).map(([name, value]) => {
    const column = columnOf(dialect, collection, name);
    return value === null
      ? `${column} = NULL`
      : `${column} = ${params.add(toParameter(dialect, collection, name, value))}`;
  });

  const key = columnOf(dialect, collection, primaryKeyOf(collection).name);
  const idPlaceholder = params.add(id);
  const returning = dialect.returning
    ? ` RETURNING ${selectList(dialect, collection)}`
    : '';
  return {
    text: `UPDATE ${tableOf(dialect, target)} SET ${assignments.join(', ')} WHERE ${key} = ${idPlaceholder}${returning}`,
    values: params.values,
  };
}

/** DELETE one record by primary key, returning the key where supported. */
export function buildDelete(
  dialect: Dialect,
  target: Target,
  id: string,
): CompiledSql {
  const { collection } = target;
  const key = columnOf(dialect, collection, primaryKeyOf(collection).name);
  const returning = dialect.returning ? ` RETURNING ${key}` : '';
  return {
    text: `DELETE FROM ${tableOf(dialect, target)} WHERE ${key} = ${dialect.placeholder(1)}${returning}`,
    values: [id],
  };
}
