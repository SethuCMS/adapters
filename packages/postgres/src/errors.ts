/**
 * Translate PostgreSQL and network errors into the platform's error codes.
 *
 * Database messages can contain hostnames, table names or fragments of SQL,
 * so they are never copied into the result. Only the code is used.
 */
import { SethuError, errors, isSethuError } from '@sethucms/core';

// Node socket error codes meaning "could not reach the server".
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Map any thrown value to a SethuError using the SQLSTATE `code` (or Node's
 * socket code). Unknown errors become a generic internal error that carries
 * only the code; the original is attached as the cause, not as the message.
 */
export function mapPostgresError(error: unknown): SethuError {
  if (isSethuError(error)) {
    return error;
  }

  // SQLSTATE (5 chars) from `pg`, or a Node socket code such as ECONNRESET.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';

  // 28P01 invalid_password, 28000 invalid_authorization_specification.
  if (code === '28P01' || code === '28000') {
    return errors.authFailed('The database rejected the credentials');
  }
  // 42501 insufficient_privilege.
  if (code === '42501') {
    return errors.forbidden('The database user is not allowed to do this');
  }
  // 25006 read_only_sql_transaction (the session is forced read-only).
  if (code === '25006') {
    return errors.readOnly();
  }
  // 23505 unique_violation.
  if (code === '23505') {
    return errors.conflict(
      'A record with the same unique value already exists',
    );
  }
  // Bad input from the caller: not-null 23502, foreign key 23503, check 23514,
  // too long 22001, out of range 22003, bad date/time 22007/22008, and bad
  // text representation 22P02 (e.g. "abc" for an integer column).
  if (
    [
      '23502',
      '23503',
      '23514',
      '22001',
      '22003',
      '22007',
      '22008',
      '22P02',
    ].includes(code)
  ) {
    return errors.validation('The database rejected the value');
  }
  // 57014 query_canceled, which is what statement_timeout raises.
  if (code === '57014' || code === 'ETIMEDOUT') {
    return errors.timeout('The database took too long to respond');
  }
  // 53300 too_many_connections, 53400 configuration_limit_exceeded.
  if (code === '53300' || code === '53400') {
    return errors.rateLimited('The database has too many connections');
  }
  // Class 08 is connection exceptions; 57P01 admin_shutdown and 57P03
  // cannot_connect_now mean the server is going away or starting up.
  if (
    NETWORK_CODES.has(code) ||
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P03'
  ) {
    return errors.connectionFailed('Could not reach the database');
  }
  return errors.internal('Database error', { code }, error);
}

/**
 * True when Postgres says a value is not valid for the column type (for
 * example "abc" for an integer key). 22P02 is invalid_text_representation.
 */
export function isInvalidTextError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '22P02'
  );
}
