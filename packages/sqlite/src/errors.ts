/**
 * Translate SQLite errors into the platform's error codes.
 * Messages can include table and column names, so only the code is used.
 */
import { SethuError, errors, isSethuError } from '@sethucms/core';

/**
 * Map any thrown value to a SethuError using SQLite's numeric `errcode`.
 * Unknown errors become a generic internal error that carries only the code;
 * the original is the cause, not the message.
 */
export function mapSqliteError(error: unknown): SethuError {
  if (isSethuError(error)) {
    return error;
  }

  // SQLite reports an "extended" result code (e.g. 2067) whose low byte is
  // the primary code (e.g. 19 = CONSTRAINT).
  const errcode =
    typeof error === 'object' && error !== null && 'errcode' in error
      ? Number((error as { errcode: unknown }).errcode)
      : NaN;
  const primary = Number.isFinite(errcode) ? errcode & 0xff : NaN;

  if (primary === 19) {
    // 2067 UNIQUE, 1555 PRIMARY KEY: the value is taken. Anything else
    // (NOT NULL, CHECK, FOREIGN KEY) is a rejected value.
    return errcode === 2067 || errcode === 1555
      ? errors.conflict('A record with the same unique value already exists')
      : errors.validation('The database rejected the value');
  }
  // 8 = READONLY.
  if (primary === 8) {
    return errors.readOnly();
  }
  // 5 = BUSY, 6 = LOCKED: another connection holds the file.
  if (primary === 5 || primary === 6) {
    return errors.timeout('The database file is busy');
  }
  // 14 = CANTOPEN, 26 = NOTADB (not a database file), 11 = CORRUPT.
  if (primary === 14 || primary === 26 || primary === 11) {
    return errors.connectionFailed('Could not open the database file');
  }
  // 20 = MISMATCH (datatype), 18 = TOOBIG (value too large).
  if (primary === 20 || primary === 18) {
    return errors.validation('The database rejected the value');
  }
  return errors.internal(
    'Database error',
    { code: Number.isFinite(errcode) ? String(errcode) : '' },
    error,
  );
}
