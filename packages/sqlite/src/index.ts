/**
 * Public surface of @sethucms/adapter-sqlite: the adapter, client factory,
 * settings parser, type mapping and error mapping.
 */
export * from './sqlite-adapter.js';
export { createSqliteClient, type SqlClientFactory } from './client.js';
export { parseSettings, type SqliteSettings } from './settings.js';
export { mapSqliteType } from './type-map.js';
export { mapSqliteError } from './errors.js';
