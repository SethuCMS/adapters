/**
 * Building PostgreSQL statements.
 *
 * The work is done by the shared sql-kit (the same code builds MySQL and
 * SQLite statements), with PostgreSQL's dialect. These wrappers keep the
 * adapter's original call shape.
 */
import type { Query } from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';
import {
  buildDelete as kitDelete,
  buildGet as kitGet,
  buildInsert as kitInsert,
  buildSelect as kitSelect,
  buildUpdate as kitUpdate,
  escapeLike,
  postgresDialect,
  type CompiledSql,
  type Target,
} from '@sethucms/adapter-sql-kit';

// Re-exported so callers need not import sql-kit directly.
export type { CompiledSql, Target };
export { escapeLike };

/**
 * Quote a table, column or schema name. Refuses anything that is not a plain
 * identifier, so a name can never close the quotes and inject SQL.
 */
export const quoteIdentifier = (name: string): string =>
  postgresDialect.quote(name);

/** List query; fetches limit+1 rows so the caller can detect a next page. */
export const buildSelect = (
  target: Target,
  query: Query,
  offset: number,
): CompiledSql => kitSelect(postgresDialect, target, query, offset);
/** Select one record by primary key. */
export const buildGet = (target: Target, id: string): CompiledSql =>
  kitGet(postgresDialect, target, id);
/** Insert one record; RETURNING gives back the stored row. */
export const buildInsert = (target: Target, values: RecordData): CompiledSql =>
  kitInsert(postgresDialect, target, values);
/** Update one record by primary key, returning the stored row. */
export const buildUpdate = (
  target: Target,
  id: string,
  values: RecordData,
): CompiledSql => kitUpdate(postgresDialect, target, id, values);
/** Delete one record by primary key, returning the key if it existed. */
export const buildDelete = (target: Target, id: string): CompiledSql =>
  kitDelete(postgresDialect, target, id);
