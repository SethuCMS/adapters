/**
 * Unit tests that need no database: column type mapping (including the
 * tinyint(1) boolean convention and the lossy fallback), error-code mapping
 * without leaking native messages, and connection settings validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSethuError } from '@sethucms/core';
import { mapMysqlType, mapMysqlError, parseSettings } from '../src/index.js';

test('column types map to canonical types', () => {
  assert.equal(mapMysqlType('tinyint', 'tinyint(1)').type, 'boolean');
  assert.equal(mapMysqlType('tinyint', 'tinyint(4)').type, 'integer');
  assert.equal(mapMysqlType('bigint', 'bigint(20)').type, 'integer');
  assert.equal(mapMysqlType('decimal', 'decimal(10,2)').type, 'decimal');
  assert.equal(mapMysqlType('varchar', 'varchar(20)').type, 'string');
  assert.equal(mapMysqlType('longtext', 'longtext').type, 'text');
  assert.equal(mapMysqlType('datetime', 'datetime(6)').type, 'datetime');
  assert.equal(mapMysqlType('longblob', 'longblob').type, 'binary');
  assert.deepEqual(mapMysqlType('geometry', 'geometry'), {
    type: 'string',
    lossy: true,
  });
});

test('driver errors become platform errors without leaking text', () => {
  const cases: Array<[number, string]> = [
    [1045, 'AUTH_FAILED'],
    [1062, 'CONFLICT'],
    [1452, 'VALIDATION_FAILED'],
    [1792, 'READ_ONLY'],
    [1142, 'FORBIDDEN'],
    [3024, 'TIMEOUT'],
    [9999, 'INTERNAL'],
  ];
  for (const [errno, code] of cases) {
    const mapped = mapMysqlError({
      errno,
      message: "Duplicate entry 'secret@example.com' for key 'users.email'",
    });
    assert.ok(isSethuError(mapped));
    assert.equal(mapped.code, code);
    assert.doesNotMatch(mapped.message, /secret|users/);
  }
  assert.equal(
    mapMysqlError({ code: 'ECONNREFUSED' }).code,
    'CONNECTION_FAILED',
  );
});

test('settings are validated and never echo credentials', () => {
  const ok = {
    connectionId: 'c',
    config: { host: 'db.example.com', database: 'app' },
    credentials: { user: 'u', password: 'hunter2' },
    readOnly: false,
  };
  assert.equal(parseSettings(ok).port, 3306);
  assert.equal(parseSettings(ok).ssl, true);
  assert.throws(
    () =>
      parseSettings({
        ...ok,
        config: { host: 'bad host!', database: 'a-b' },
        credentials: { user: '', password: 'hunter2' },
      }),
    (e) =>
      isSethuError(e) &&
      !e.message.includes('hunter2') &&
      /host/.test(e.message),
  );
});
