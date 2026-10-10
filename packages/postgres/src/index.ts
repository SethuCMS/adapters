/**
 * Public surface of @sethucms/adapter-postgres: the adapter, its settings
 * parser and client types, SQL builders, type mapping and error mapping.
 */
export * from './postgres-adapter.js';
export {
  createPgClient,
  parseSettings,
  type SqlClient,
  type SqlClientFactory,
  type SqlResult,
} from './client.js';
export {
  buildSelect,
  buildGet,
  buildInsert,
  buildUpdate,
  buildDelete,
  quoteIdentifier,
  escapeLike,
  type CompiledSql,
} from './sql.js';
export { mapPgType } from './type-map.js';
export { mapPostgresError } from './errors.js';
