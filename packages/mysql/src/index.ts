/**
 * Public surface of @sethucms/adapter-mysql (MySQL and MariaDB): the adapter,
 * client factory, settings parser, type mapping and error mapping.
 */
export * from './mysql-adapter.js';
export { createMysqlClient, type SqlClientFactory } from './client.js';
export { parseSettings, type MysqlSettings } from './settings.js';
export { mapMysqlType } from './type-map.js';
export { mapMysqlError } from './errors.js';
