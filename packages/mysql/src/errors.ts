/**
 * Translate MySQL / MariaDB errors into the platform's error codes.
 * Database messages can contain table names or fragments of SQL, so only the
 * code is used.
 */
import { SethuError, errors, isSethuError } from '@sethucms/core';

// Node socket and mysql2 codes meaning "could not reach the server".
const NETWORK = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
]);
// MySQL error numbers for "the database refused this value or statement":
// NOT NULL (1048), unknown column (1054), syntax (1064), column count (1136),
// out of range / truncated / bad value (1264, 1265, 1292, 1366, 1406, 1690),
// foreign key violations (1451, 1452), and invalid JSON or failed CHECK
// constraints (3140, 3819, 4025).
const VALUE_REJECTED = new Set([
  1048, 1054, 1064, 1136, 1264, 1265, 1292, 1366, 1406, 1451, 1452, 1690, 3140,
  3819, 4025,
]);

/**
 * Map any thrown value to a SethuError using MySQL's numeric `errno` (or the
 * driver's string `code`). Unknown errors become a generic internal error
 * that carries only the code; the original is the cause, not the message.
 */
export function mapMysqlError(error: unknown): SethuError {
  if (isSethuError(error)) {
    return error;
  }
  // Tolerate non-object throws; fields are read defensively.
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    errno?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : '';
  const errno = typeof e.errno === 'number' ? e.errno : 0;

  // 1045 access denied; 1698 access denied (auth plugin, e.g. root socket).
  if (errno === 1045 || errno === 1698) {
    return errors.authFailed('The database rejected the credentials');
  }
  // Missing privilege: on the database (1044), on a table, column or routine
  // (1142, 1143, 1370), or a global right (1227).
  if ([1044, 1142, 1143, 1227, 1370].includes(errno)) {
    return errors.forbidden('The database user is not allowed to do this');
  }
  // 1792: write in a read-only transaction; 1290: --read-only server option.
  if (errno === 1792 || errno === 1290) {
    return errors.readOnly();
  }
  // 1062 duplicate entry for a unique key.
  if (errno === 1062) {
    return errors.conflict(
      'A record with the same unique value already exists',
    );
  }
  if (VALUE_REJECTED.has(errno)) {
    return errors.validation('The database rejected the value');
  }
  // Query/statement time limits: 3024 (MySQL max_execution_time), 1969
  // (MariaDB max_statement_time), 1317 interrupted, or a driver timeout.
  if (
    errno === 3024 ||
    errno === 1969 ||
    errno === 1317 ||
    code === 'PROTOCOL_SEQUENCE_TIMEOUT'
  ) {
    return errors.timeout('The database took too long to respond');
  }
  // 1040 too many connections; 1203 user connection limit reached.
  if (errno === 1040 || errno === 1203) {
    return errors.rateLimited('The database has too many connections');
  }
  // 2002/2003 cannot connect, 2013 connection lost during the query.
  if (NETWORK.has(code) || errno === 2002 || errno === 2003 || errno === 2013) {
    return errors.connectionFailed('Could not reach the database');
  }
  return errors.internal(
    'Database error',
    { code: code || String(errno) },
    error,
  );
}
