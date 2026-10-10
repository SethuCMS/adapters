/** Translate Firestore (gRPC) errors into the platform's error codes. Only the numeric code is used. */
import { SethuError, errors, isSethuError } from '@sethucms/core';

/**
 * Map any thrown value to a {@link SethuError}. Firestore errors carry gRPC
 * status codes (5 NOT_FOUND, 6 ALREADY_EXISTS, 7 PERMISSION_DENIED, ...);
 * only that number is read, never the message.
 */
export function mapFirestoreError(error: unknown): SethuError {
  if (isSethuError(error)) {
    return error;
  }
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number'
      ? (error as { code: number }).code
      : -1;

  switch (code) {
    case 5:
      return errors.notFound('Record not found');
    case 6:
      return errors.conflict('A record with the same id already exists');
    case 7:
      return errors.forbidden('The service account is not allowed to do this');
    case 16:
      return errors.authFailed('The database rejected the credentials');
    case 3:
    case 11:
      return errors.validation('The database rejected the value');
    // FAILED_PRECONDITION: usually "query needs a composite index". Report
    // it as unsupported with advice, since SethuCMS cannot create indexes.
    case 9:
      return errors.unsupported(
        'Firestore needs an index for this query. Create it in the Firebase console, or filter and sort differently',
      );
    case 4:
      return errors.timeout('The database took too long to respond');
    case 8:
      return errors.rateLimited('The database is rate limiting requests');
    // UNAVAILABLE / UNKNOWN: treat as a connectivity problem.
    case 14:
    case 2:
      return errors.connectionFailed('Could not reach the database');
    default:
      return errors.internal('Database error', { code: String(code) }, error);
  }
}
