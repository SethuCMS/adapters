/**
 * Unit tests for the MongoDB adapter's pure logic (query translation, injection
 * safety, schema inference, error mapping, settings). No server needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineCollection, parseQuery, isSethuError } from '@sethucms/core';
import {
  compileFilter,
  compileFind,
  escapeRegex,
  assertSafeJson,
  inferCollection,
  mapMongoError,
  parseSettings,
} from '../src/index.js';

// Fixture: integer key named `id` (stored as `_id`) plus array and datetime
// fields, enough to exercise every translation branch.
const posts = defineCollection({
  name: 'posts',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'title', type: 'string' },
    { name: 'tags', type: 'array' },
    { name: 'at', type: 'datetime' },
  ],
});
const q = (input: object) => parseQuery({ collection: 'posts', ...input });

// Pins id mapping: callers say `id`, Mongo sees `_id`. The key is also
// appended to the sort so offset paging stays deterministic.
test('the primary key is stored as _id and sorts are tie-broken on it', () => {
  const spec = compileFind(
    posts,
    q({
      filter: { field: 'id', op: 'gt', value: 3 },
      sort: [{ field: 'title', dir: 'desc' }],
    }),
  );
  assert.deepEqual(spec.filter, { _id: { $gt: 3 } });
  assert.deepEqual(spec.sort, { title: -1, _id: 1 });
});

// Operator-injection guard: an object filter value (`{ $ne: null }`)
// must be rejected, and user text must be escaped into a literal regex.
test('text matching is escaped and cannot carry operators', () => {
  assert.deepEqual(
    compileFilter(posts, { field: 'title', op: 'contains', value: 'a.*(b)' }),
    { title: { $regex: 'a\\.\\*\\(b\\)', $options: 'i' } },
  );
  assert.equal(escapeRegex('^$'), '\\^\\$');
  assert.throws(
    () =>
      compileFilter(posts, { field: 'title', op: 'eq', value: { $ne: null } }),
    (e) => isSethuError(e),
  );
  assert.throws(
    () => compileFilter(posts, { field: 'nope', op: 'eq', value: 1 }),
    (e) => isSethuError(e),
  );
});

// Consistency with the SQL adapters: null/missing semantics must match
// so the same portable filter returns the same rows on every backend.
test('null handling matches the SQL adapters', () => {
  assert.deepEqual(
    compileFilter(posts, { field: 'title', op: 'eq', value: null }),
    { title: null },
  );
  assert.deepEqual(
    compileFilter(posts, { field: 'title', op: 'ne', value: null }),
    { title: { $ne: null } },
  );
  assert.deepEqual(
    compileFilter(posts, { field: 'title', op: 'exists', value: false }),
    { title: null },
  );
  assert.deepEqual(
    compileFilter(posts, { field: 'tags', op: 'contains', value: 'x' }),
    { tags: 'x' },
  );
  assert.deepEqual(
    compileFilter(posts, { not: { field: 'title', op: 'eq', value: 'a' } }),
    { $nor: [{ title: 'a' }] },
  );
});

test('dates in filters become Dates', () => {
  const f = compileFilter(posts, {
    field: 'at',
    op: 'gte',
    value: '2024-01-01T00:00:00.000Z',
  }) as { at: { $gte: Date } };
  assert.ok(f.at.$gte instanceof Date);
});

// Written JSON may not contain `$` keys or dotted paths, otherwise a
// later $set could be turned into an operator.
test('JSON values may not carry operators or paths', () => {
  assert.throws(() => assertSafeJson({ a: { $where: 'x' } }));
  assert.throws(() => assertSafeJson({ 'a.b': 1 }));
  assert.throws(() => assertSafeJson([{ ok: 1 }, { $set: 1 }]));
  assert.doesNotThrow(() => assertSafeJson({ a: [1, { b: 'c' }] }));
});

// Inference is conservative: mixed kinds become lossy json, int+float
// becomes decimal, and nothing except the key is ever "required".
test('collections are guessed from samples, conservatively', () => {
  const guess = inferCollection('events', [
    {
      _id: 1,
      name: 'a',
      n: 1,
      mixed: 1,
      at: new Date(),
      tags: ['x'],
      meta: { a: 1 },
      ok: true,
    },
    { _id: 2, name: 'b', n: 1.5, mixed: 'text', at: new Date(), extra: null },
  ])!;
  const field = (name: string) => guess.fields.find((f) => f.name === name)!;
  assert.equal(field('_id').type, 'integer');
  assert.equal(field('_id').primaryKey, true);
  assert.equal(field('n').type, 'decimal');
  assert.equal(field('mixed').lossy, true);
  assert.equal(field('at').type, 'datetime');
  assert.equal(field('tags').type, 'array');
  assert.equal(field('meta').type, 'json');
  assert.equal(field('ok').type, 'boolean');
  assert.ok(guess.fields.every((f) => f.primaryKey || !f.required));
  // an empty collection still gets a key
  assert.equal(inferCollection('empty', [])!.fields.length, 1);
  assert.equal(inferCollection('bad-name', []), undefined);
});

// Driver messages can echo user data (e.g. the duplicate value), so only
// error codes may reach callers.
test('errors become platform errors without driver text', () => {
  assert.equal(
    mapMongoError({
      code: 11000,
      message: 'E11000 duplicate key {email: "a@b.c"}',
    }).code,
    'CONFLICT',
  );
  assert.equal(mapMongoError({ code: 18 }).code, 'AUTH_FAILED');
  assert.equal(mapMongoError({ code: 50 }).code, 'TIMEOUT');
  assert.equal(
    mapMongoError({
      name: 'MongoServerSelectionError',
      message: 'host db.internal',
    }).code,
    'CONNECTION_FAILED',
  );
  assert.doesNotMatch(
    mapMongoError({ code: 11000, message: 'a@b.c' }).message,
    /a@b/,
  );
});

// Secure defaults, and a bad config error must never leak the password.
test('settings: tls on by default, credentials optional, never echoed', () => {
  const base = {
    connectionId: 'c',
    config: { host: 'db.example.com', database: 'app' },
    credentials: { user: 'u', password: 'hunter2' },
    readOnly: false,
  };
  assert.equal(parseSettings(base).tls, true);
  assert.equal(parseSettings({ ...base, credentials: {} }).user, '');
  assert.throws(
    () => parseSettings({ ...base, config: { host: 'a/b', database: 'x y' } }),
    (e) => isSethuError(e) && !e.message.includes('hunter2'),
  );
});
