/**
 * Tests for the Postgres SQL builders: parameter binding, paging and order,
 * filter operators and NULL handling, LIKE escaping, identifier safety, and
 * insert/update/delete statements. Pure string checks; no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineCollection,
  parseQuery,
  eq,
  and,
  or,
  not,
  isSethuError,
} from '@sethucms/core';
import {
  buildSelect,
  buildGet,
  buildInsert,
  buildUpdate,
  buildDelete,
  quoteIdentifier,
  escapeLike,
} from '../src/index.js';

const orders = defineCollection({
  name: 'orders',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'status', type: 'string' },
    { name: 'total', type: 'decimal' },
    { name: 'tags', type: 'array' },
    { name: 'meta', type: 'json' },
  ],
  relations: [],
});
const target = { schema: 'public', collection: orders };
const select = (body: object = {}, offset = 0) =>
  buildSelect(target, parseQuery({ collection: 'orders', ...body }), offset);

test('values are parameters, never part of the SQL text', () => {
  const nasty = `x'; DROP TABLE orders; --`;
  const { text, values } = select({ filter: eq('status', nasty) });
  assert.ok(!text.includes('DROP'));
  assert.ok(!text.includes(nasty));
  assert.deepEqual(values.slice(0, 1), [nasty]);
  assert.match(text, /"status" = \$1/);
});

test('plain listing: stable order, one extra row, offset', () => {
  const { text, values } = select({ page: { limit: 10 } }, 20);
  assert.equal(
    text,
    'SELECT "id", "status", "total", "tags", "meta" FROM "public"."orders" ORDER BY "id" ASC NULLS FIRST LIMIT $1 OFFSET $2',
  );
  assert.deepEqual(values, [11, 20]);
});

test('sorting by a field still ends with the primary key', () => {
  const { text } = select({ sort: [{ field: 'total', dir: 'desc' }] });
  assert.match(text, /ORDER BY "total" DESC NULLS LAST, "id" ASC NULLS FIRST/);
});

test('projection limits the columns', () => {
  assert.match(
    select({ projection: ['id', 'status'] }).text,
    /^SELECT "id", "status" FROM/,
  );
});

test('combinators and operators', () => {
  const filter = and(
    or(eq('status', 'a'), { field: 'total', op: 'gte', value: 5 }),
    not(eq('status', 'b')),
  );
  const { text, values } = select({ filter });
  assert.match(text, /NOT COALESCE\("status" = \$3, FALSE\)/);
  assert.deepEqual(values.slice(0, 3), ['a', 5, 'b']);
});

test('null handling: eq/ne/in/nin/exists', () => {
  assert.match(select({ filter: eq('status', null) }).text, /"status" IS NULL/);
  assert.match(
    select({ filter: { field: 'status', op: 'ne', value: null } }).text,
    /"status" IS NOT NULL/,
  );
  assert.match(
    select({ filter: { field: 'status', op: 'ne', value: 'x' } }).text,
    /"status" IS DISTINCT FROM \$1/,
  );
  assert.match(
    select({ filter: { field: 'status', op: 'in', value: ['a', null] } }).text,
    /\("status" IN \(\$1\) OR "status" IS NULL\)/,
  );
  assert.match(
    select({ filter: { field: 'status', op: 'nin', value: ['a'] } }).text,
    /\("status" IS NULL OR "status" NOT IN \(\$1\)\)/,
  );
  assert.match(
    select({ filter: { field: 'status', op: 'exists', value: false } }).text,
    /"status" IS NULL/,
  );
  assert.match(
    select({ filter: { field: 'status', op: 'exists' } }).text,
    /"status" IS NOT NULL/,
  );
});

test('text search escapes LIKE wildcards', () => {
  const { text, values } = select({
    filter: { field: 'status', op: 'contains', value: '50%_off\\' },
  });
  assert.match(text, /"status" ILIKE \$1 ESCAPE '\\'/);
  assert.equal(values[0], '%50\\%\\_off\\\\%');
  assert.equal(escapeLike('a%b_c'), 'a\\%b\\_c');
  assert.equal(
    select({ filter: { field: 'status', op: 'startsWith', value: 'ab' } })
      .values[0],
    'ab%',
  );
});

test('array contains uses ANY', () => {
  assert.match(
    select({ filter: { field: 'tags', op: 'contains', value: 'vip' } }).text,
    /\$1 = ANY\("tags"\)/,
  );
});

test('identifiers: only plain names, always quoted', () => {
  assert.equal(quoteIdentifier('orders'), '"orders"');
  for (const bad of [
    'a"b',
    'a b',
    'a;b',
    '',
    '1abc',
    'x'.repeat(64),
    '"; DROP TABLE x; --',
  ]) {
    assert.throws(
      () => quoteIdentifier(bad),
      (e) => isSethuError(e) && e.code === 'INTERNAL',
    );
  }
});

test('fields not in the collection are refused even if a caller skips validation', () => {
  const query = {
    collection: 'orders',
    filter: { field: 'ghost', op: 'eq', value: 1 },
    page: { limit: 5 },
  } as never;
  assert.throws(
    () => buildSelect(target, query, 0),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
});

test('a collection with an unsafe native name is refused', () => {
  const odd = defineCollection({
    name: 'safe',
    nativeName: 'bad"name',
    fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    relations: [],
  });
  assert.throws(() => buildGet({ schema: 'public', collection: odd }, '1'));
});

test('get and delete use the key and a parameter', () => {
  assert.deepEqual(buildGet(target, '7'), {
    text: 'SELECT "id", "status", "total", "tags", "meta" FROM "public"."orders" WHERE "id" = $1',
    values: ['7'],
  });
  assert.deepEqual(buildDelete(target, '7'), {
    text: 'DELETE FROM "public"."orders" WHERE "id" = $1 RETURNING "id"',
    values: ['7'],
  });
});

test('insert skips nulls, sends json as text, and falls back to DEFAULT VALUES', () => {
  const sql = buildInsert(target, {
    status: 'new',
    total: null,
    meta: { a: 1 },
  });
  assert.match(
    sql.text,
    /^INSERT INTO "public"."orders" \("status", "meta"\) VALUES \(\$1, \$2\) RETURNING/,
  );
  assert.deepEqual(sql.values, ['new', '{"a":1}']);
  assert.match(buildInsert(target, {}).text, /DEFAULT VALUES RETURNING/);
});

test('update sets null explicitly and keys on the primary key', () => {
  const sql = buildUpdate(target, '3', { status: 'done', total: null });
  assert.equal(
    sql.text,
    'UPDATE "public"."orders" SET "status" = $1, "total" = NULL WHERE "id" = $2 RETURNING "id", "status", "total", "tags", "meta"',
  );
  assert.deepEqual(sql.values, ['done', '3']);
  assert.throws(() => buildUpdate(target, '3', {}));
});
