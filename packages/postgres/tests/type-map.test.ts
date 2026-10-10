/**
 * Tests for mapPgType: common Postgres types map to canonical types, and
 * unknown types fall back to a lossy "string".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPgType } from '../src/index.js';

test('common types map cleanly', () => {
  const cases: Array<[string, string]> = [
    ['integer', 'integer'],
    ['bigint', 'integer'],
    ['numeric', 'decimal'],
    ['boolean', 'boolean'],
    ['text', 'text'],
    ['character varying', 'string'],
    ['uuid', 'string'],
    ['date', 'date'],
    ['timestamp with time zone', 'datetime'],
    ['jsonb', 'json'],
    ['ARRAY', 'array'],
    ['bytea', 'binary'],
  ];
  for (const [native, canonical] of cases) {
    assert.deepEqual(
      mapPgType(native),
      { type: canonical, lossy: false },
      native,
    );
  }
});

test('unknown types become lossy strings', () => {
  assert.deepEqual(mapPgType('tsvector'), { type: 'string', lossy: true });
  assert.deepEqual(mapPgType('constructor'), { type: 'string', lossy: true });
});
