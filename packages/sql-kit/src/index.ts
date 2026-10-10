/**
 * Public surface of @sethucms/sql-kit: the dialect-neutral SQL building blocks
 * shared by the postgres, mysql and sqlite adapters.
 */
export {
  postgresDialect,
  mysqlDialect,
  sqliteDialect,
  type Dialect,
} from './dialect.js';
export {
  buildSelect,
  buildGet,
  buildInsert,
  buildUpdate,
  buildDelete,
  escapeLike,
  selectList,
  tableOf,
  toParameter,
  type CompiledSql,
  type Target,
} from './builders.js';
export {
  buildCreateTable,
  columnType,
  type ColumnType,
  type CreateTableOptions,
} from './ddl.js';
export { normalizeRow } from './rows.js';
export type { SqlClient, SqlResult } from './client.js';
export { dropBrokenRelations } from './introspect.js';
