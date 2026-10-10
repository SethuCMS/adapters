/**
 * Tests for the shared SQL builders across all three dialects: parameter
 * binding (injection safety), paging, identifier checks, table DDL and row
 * normalisation. No database is needed; only generated SQL is inspected.
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
  buildCreateTable,
  postgresDialect,
  mysqlDialect,
  sqliteDialect,
  escapeLike,
  normalizeRow,
  type Dialect,
} from '../src/index.js';

// Fixtures: `posts` covers many column types; `comments` references it.
const posts = defineCollection({
  name: 'posts',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    {
      name: 'title',
      type: 'string',
      required: true,
      validation: { maxLength: 120 },
    },
    { name: 'views', type: 'integer' },
    { name: 'tags', type: 'array' },
    { name: 'meta', type: 'json' },
    { name: 'live', type: 'boolean' },
    { name: 'at', type: 'datetime' },
  ],
});
const comments = defineCollection({
  name: 'comments',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'post', type: 'reference', references: 'posts' },
    { name: 'body', type: 'text' },
  ],
});

// Every test in the loop below runs once per dialect.
const dialects: Dialect[] = [postgresDialect, mysqlDialect, sqliteDialect];
const query = (input: object) => parseQuery({ collection: 'posts', ...input });

for (const dialect of dialects) {
  test(`${dialect.name}: values never appear in the SQL text`, () => {
    // A classic injection payload: it must only ever appear as a bound value.
    const evil = "x'; DROP TABLE posts; --";
    const q = query({
      filter: and(eq('title', evil), or(eq('views', 3), not(eq('live', true)))),
      page: { limit: 5 },
    });
    const { text, values } = buildSelect(
      dialect,
      {
        schema: dialect.name === 'sqlite' ? undefined : 'app',
        collection: posts,
      },
      q,
      0,
    );
    assert.ok(!text.includes('DROP'));
    assert.ok(values.includes(evil));
  });

  test(`${dialect.name}: select pages with limit+1 and a stable tie-break on the key`, () => {
    const { text, values } = buildSelect(
      dialect,
      { schema: undefined, collection: posts },
      query({ sort: [{ field: 'views', dir: 'desc' }], page: { limit: 10 } }),
      20,
    );
    assert.match(text, /ORDER BY .*views.* DESC.*, .*id.* ASC/);
    if (dialect.inlineLimits) {
      assert.match(text, /LIMIT 11 OFFSET 20$/);
    } else {
      assert.deepEqual(values.slice(-2), [11, 20]);
    }
  });

  test(`${dialect.name}: unknown fields are refused`, () => {
    assert.throws(
      () =>
        buildSelect(
          dialect,
          { schema: undefined, collection: posts },
          { ...query({}), projection: ['nope'] },
          0,
        ),
      (e) => isSethuError(e),
    );
  });

  test(`${dialect.name}: unsafe identifiers are refused`, () => {
    // Quotes and whitespace could break out of the quoted identifier.
    assert.throws(() => dialect.quote('a"b'));
    assert.throws(() => dialect.quote('a b'));
    assert.throws(() => dialect.quote(''));
  });

  test(`${dialect.name}: insert, update and delete are parameterised`, () => {
    const target = { schema: undefined, collection: posts };
    const insert = buildInsert(dialect, target, {
      title: 'a',
      views: 1,
      live: true,
      tags: ['x'],
      meta: { a: 1 },
    });
    assert.equal(insert.values.length, 5);
    assert.equal(/RETURNING/.test(insert.text), dialect.returning);
    const update = buildUpdate(dialect, target, '7', {
      title: 'b',
      views: null,
    });
    assert.match(update.text, /views.* = NULL/);
    assert.equal(update.values.at(-1), '7');
    assert.equal(buildDelete(dialect, target, '7').values[0], '7');
    assert.equal(buildGet(dialect, target, '7').values[0], '7');
    assert.throws(() => buildUpdate(dialect, target, '1', {}));
  });

  test(`${dialect.name}: contains and startsWith escape wildcards`, () => {
    const { values } = buildSelect(
      dialect,
      { schema: undefined, collection: posts },
      query({ filter: { field: 'title', op: 'contains', value: '50%_off\\' } }),
      0,
    );
    assert.equal(values[0], `%${escapeLike('50%_off\\')}%`);
    assert.equal(values[0], '%50\\%\\_off\\\\%');
  });

  test(`${dialect.name}: creates a table with the right key and a foreign key only to existing tables`, () => {
    const all = new Map([
      [posts.name, posts],
      [comments.name, comments],
    ]);
    const withFk = buildCreateTable(dialect, {
      schema: dialect.name === 'sqlite' ? undefined : 'app',
      collection: comments,
      all,
      existing: new Set(['posts']),
    });
    const without = buildCreateTable(dialect, {
      schema: undefined,
      collection: comments,
      all,
      existing: new Set(),
    });
    assert.equal(withFk.statements.length, 1);
    assert.match(withFk.statements[0]!.text, /FOREIGN KEY/);
    assert.doesNotMatch(without.statements[0]!.text, /FOREIGN KEY/);
    const text = withFk.statements[0]!.text;
    if (dialect.name === 'postgres') {
      assert.match(text, /GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY/);
    }
    if (dialect.name === 'mysql') {
      assert.match(text, /AUTO_INCREMENT[\s\S]*PRIMARY KEY/);
    }
    if (dialect.name === 'sqlite') {
      assert.match(text, /INTEGER PRIMARY KEY AUTOINCREMENT/);
    }
  });
}

test('postgres uses ILIKE and $n; mysql and sqlite use ?', () => {
  const q = query({ filter: { field: 'title', op: 'contains', value: 'a' } });
  assert.match(
    buildSelect(postgresDialect, { schema: 'p', collection: posts }, q, 0).text,
    /ILIKE \$1/,
  );
  assert.match(
    buildSelect(mysqlDialect, { schema: 'p', collection: posts }, q, 0).text,
    /LIKE \?/,
  );
});

test('mysql ne is null-safe and booleans become 0/1', () => {
  const q = query({ filter: { field: 'live', op: 'ne', value: true } });
  const built = buildSelect(
    mysqlDialect,
    { schema: undefined, collection: posts },
    q,
    0,
  );
  assert.match(built.text, /<=>/);
  assert.equal(built.values[0], 1);
});

test('rows are normalised the same way for every database', () => {
  const row = normalizeRow(posts, {
    id: 5n,
    title: 't',
    views: '12',
    tags: '["a"]',
    meta: '{"x":1}',
    live: 1,
    at: new Date('2024-01-02T03:04:05Z'),
  });
  assert.deepEqual(row, {
    id: 5,
    title: 't',
    views: 12,
    tags: ['a'],
    meta: { x: 1 },
    live: true,
    at: '2024-01-02T03:04:05.000Z',
  });
});

test('mysql writes LIMIT and OFFSET as checked integers; the others use parameters', () => {
  const q = query({ page: { limit: 5 } });
  const mysql = buildSelect(
    mysqlDialect,
    { schema: undefined, collection: posts },
    q,
    10,
  );
  assert.match(mysql.text, /LIMIT 6 OFFSET 10$/);
  assert.equal(mysql.values.length, 0);
  assert.throws(() =>
    buildSelect(mysqlDialect, { schema: undefined, collection: posts }, q, -1),
  );
  assert.throws(() =>
    buildSelect(mysqlDialect, { schema: undefined, collection: posts }, q, 1.5),
  );
  assert.equal(
    buildSelect(sqliteDialect, { schema: undefined, collection: posts }, q, 10)
      .values.length,
    2,
  );
});
