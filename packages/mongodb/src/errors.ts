/** Translate MongoDB errors into the platform's error codes. Only codes are used, never driver text. */
import { SethuError, errors, isSethuError } from '@sethucms/core';

/**
 * Map any thrown value to a {@link SethuError}. Already-mapped errors pass
 * through so nested `run()` calls do not double-wrap.
 */
export function mapMongoError(error: unknown): SethuError {
  if (isSethuError(error)) {
    return error;
  }
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    name?: unknown;
  };
  const code = typeof e.code === 'number' ? e.code : 0;
  const name = typeof e.name === 'string' ? e.name : '';

  // 11000/11001: duplicate key on a unique index.
  if (code === 11000 || code === 11001) {
    return errors.conflict(
      'A record with the same unique value already exists',
    );
  }
  // 18 AuthenticationFailed, 8000 Atlas auth failure.
  if (code === 18 || code === 8000) {
    return errors.authFailed('The database rejected the credentials');
  }
  // 13 Unauthorized, 31 RoleNotFound, 20 IllegalOperation, 97 read-only
  // style permission failures: the user lacks privileges.
  if (code === 13 || code === 31 || code === 20 || code === 97) {
    return errors.forbidden('The database user is not allowed to do this');
  }
  // 50 MaxTimeMSExpired: our maxTimeMS cap on a statement fired.
  if (code === 50 || name === 'MongoNetworkTimeoutError') {
    return errors.timeout('The database took too long to respond');
  }
  // 121 DocumentValidationFailure and related schema/type errors.
  if (code === 121 || code === 2 || code === 14 || code === 52 || code === 53) {
    return errors.validation('The database rejected the value');
  }
  if (
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoNotConnectedError' ||
    name === 'MongoTopologyClosedError'
  ) {
    return errors.connectionFailed('Could not reach the database');
  }
  if (
    name === 'MongoServerError' &&
    /auth/i.test(String((error as { codeName?: unknown }).codeName ?? ''))
  ) {
    return errors.authFailed('The database rejected the credentials');
  }
  return errors.internal(
    'Database error',
    { code: String(code || name) },
    error,
  );
}
