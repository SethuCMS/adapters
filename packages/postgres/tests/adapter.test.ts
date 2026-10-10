/**
 * Tests for PostgresAdapter against a scripted FakeClient: settings
 * validation, row normalisation and paging, error mapping (no leaked native
 * messages), connect failure cleanup, and catalog introspection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineCollection, isSethuError, parseQuery } from '@sethucms/core';
import {
  PostgresAdapter,
  mapPostgresError,
  parseSettings,
} from '../src/index.js';
import { FakeClient, pgError } from './helpers/fake-client.js';

const things = defineCollection({
  name: 'things',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'name', type: 'string' },
    { name: 'seen', type: 'datetime' },
  ],
  relations: [],
});

// The password is distinctive so tests can assert it never appears in output.
const connectInput = {
  connectionId: 'c1',
  config: { host: 'db.example.com', database: 'app' },
  credentials: { user: 'cms', password: 'super-secret-pw' },
  readOnly: true,
};

async function connected(client: FakeClient) {
  const adapter = new PostgresAdapter({ clientFactory: async () => client });
  await adapter.connect(connectInput);
  return adapter;
}

test('settings: defaults are safe, bad values are rejected without echoing secrets', () => {
  const settings = parseSettings(connectInput);
  assert.equal(settings.ssl, true, 'TLS is on by default');
  assert.equal(settings.schema, 'public');
  assert.equal(settings.port, 5432);

  const bad = {
    ...connectInput,
    config: { host: 'a b;c', database: 'x', schema: 'pub"lic', port: 99999 },
    credentials: { user: '', password: 'leaky-pw' },
  };
  assert.throws(
    () => parseSettings(bad),
    (e) => {
      assert.ok(isSethuError(e) && e.code === 'VALIDATION_FAILED');
      assert.ok(!e.message.includes('leaky-pw'));
      assert.match(e.message, /host/);
      assert.match(e.message, /schema/);
      return true;
    },
  );
});

test('find: reads rows, normalises values, reports the next position', async () => {
  const client = new FakeClient((call) =>
    call.text.startsWith('SELECT 1')
      ? { rows: [] }
      : {
          rows: [
            { id: '1', name: 'a', seen: new Date('2024-05-01T10:00:00Z') },
            { id: '2', name: 'b', seen: null },
            { id: '3', name: 'c', seen: null },
          ],
        },
  );
  const adapter = await connected(client);
  const result = await adapter.find(
    things,
    parseQuery({ collection: 'things', page: { limit: 2 } }),
    undefined,
  );

  assert.deepEqual(result.records, [
    { id: 1, name: 'a', seen: '2024-05-01T10:00:00.000Z' },
    { id: 2, name: 'b', seen: null },
  ]);
  assert.deepEqual(result.nextPosition, { offset: 2 });
  assert.deepEqual(
    client.calls.at(-1)?.values,
    [3, 0],
    'asked for limit + 1 rows from offset 0',
  );
});

test('find: last page has no next position', async () => {
  const client = new FakeClient(() => ({
    rows: [{ id: 1, name: 'a', seen: null }],
  }));
  const adapter = await connected(client);
  const result = await adapter.find(
    things,
    parseQuery({ collection: 'things', page: { limit: 5 } }),
    { offset: 10 },
  );
  assert.equal(result.nextPosition, undefined);
  assert.deepEqual(client.calls.at(-1)?.values, [6, 10]);
});

test('get: missing row is null; invalid key text counts as missing', async () => {
  const empty = await connected(new FakeClient());
  assert.equal(await empty.get(things, '5'), null);

  const invalidKey = await connected(
    new FakeClient((call) =>
      call.text.startsWith('SELECT 1') ? { rows: [] } : pgError('22P02'),
    ),
  );
  assert.equal(await invalidKey.get(things, 'abc'), null);
});

test('update and delete: no matching row is NOT_FOUND', async () => {
  const adapter = await connected(new FakeClient());
  await assert.rejects(
    adapter.update(things, '1', { name: 'x' }),
    (e) => isSethuError(e) && e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    adapter.delete(things, '1'),
    (e) => isSethuError(e) && e.code === 'NOT_FOUND',
  );
});

test('database errors map to platform codes without leaking native messages', () => {
  const cases: Array<[string, string]> = [
    ['28P01', 'AUTH_FAILED'],
    ['42501', 'FORBIDDEN'],
    ['25006', 'READ_ONLY'],
    ['23505', 'CONFLICT'],
    ['23502', 'VALIDATION_FAILED'],
    ['22P02', 'VALIDATION_FAILED'],
    ['57014', 'TIMEOUT'],
    ['53300', 'RATE_LIMITED'],
    ['ECONNREFUSED', 'CONNECTION_FAILED'],
    ['08006', 'CONNECTION_FAILED'],
    ['XX000', 'INTERNAL'],
  ];
  for (const [native, expected] of cases) {
    const mapped = mapPostgresError(pgError(native));
    assert.equal(mapped.code, expected, native);
    assert.ok(
      !mapped.message.includes('db.internal'),
      `${native} leaked the native message`,
    );
  }
  assert.equal(mapPostgresError(new Error('boom')).code, 'INTERNAL');
});

test('connect: failure maps to a safe error and releases the client', async () => {
  const client = new FakeClient(() => pgError('28P01'));
  const adapter = new PostgresAdapter({ clientFactory: async () => client });
  await assert.rejects(
    adapter.connect(connectInput),
    (e) => isSethuError(e) && e.code === 'AUTH_FAILED',
  );
  assert.equal(client.closed, true);
  await assert.rejects(
    adapter.get(things, '1'),
    (e) => isSethuError(e) && e.code === 'CONNECTION_FAILED',
  );
});

test('introspect: builds collections from the catalog, skipping what it cannot handle safely', async () => {
  const client = new FakeClient((call) => {
    if (call.text.includes('information_schema.columns')) {
      return {
        rows: [
          {
            table_name: 'authors',
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: "nextval('authors_id_seq'::regclass)",
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'authors',
            column_name: 'name',
            data_type: 'character varying',
            is_nullable: 'NO',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'posts',
            column_name: 'id',
            data_type: 'bigint',
            is_nullable: 'NO',
            column_default: null,
            is_identity: 'YES',
            is_generated: 'NEVER',
          },
          {
            table_name: 'posts',
            column_name: 'author_id',
            data_type: 'integer',
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'posts',
            column_name: 'body',
            data_type: 'tsvector',
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'posts',
            column_name: 'bad name',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'no_key',
            column_name: 'x',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
          {
            table_name: 'Bad-Table',
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            is_identity: 'NO',
            is_generated: 'NEVER',
          },
        ],
      };
    }
    if (call.text.includes("'PRIMARY KEY'")) {
      return {
        rows: [
          { table_name: 'authors', column_name: 'id' },
          { table_name: 'posts', column_name: 'id' },
          { table_name: 'Bad-Table', column_name: 'id' },
        ],
      };
    }
    if (call.text.includes("'FOREIGN KEY'")) {
      return {
        rows: [
          {
            table_name: 'posts',
            column_name: 'author_id',
            target_table: 'authors',
            target_column: 'id',
            constraint_name: 'fk1',
          },
          {
            table_name: 'posts',
            column_name: 'author_id',
            target_table: 'Bad-Table',
            target_column: 'id',
            constraint_name: 'fk2',
          },
        ],
      };
    }
    return { rows: [] };
  });
  const collections = await (await connected(client)).introspect();

  assert.deepEqual(
    collections.map((c) => c.name).sort(),
    ['authors', 'posts'],
    'unkeyed and oddly named tables are skipped',
  );

  const authors = collections.find((c) => c.name === 'authors')!;
  const id = authors.fields.find((f) => f.name === 'id')!;
  assert.equal(id.primaryKey, true);
  assert.equal(id.generated, true, 'serial columns are generated');
  assert.equal(authors.fields.find((f) => f.name === 'name')!.required, true);

  const posts = collections.find((c) => c.name === 'posts')!;
  assert.deepEqual(
    posts.fields.map((f) => f.name),
    ['id', 'author_id', 'body'],
    'a column with an unsafe name is skipped',
  );
  assert.equal(posts.fields.find((f) => f.name === 'body')!.lossy, true);
  assert.deepEqual(
    posts.relations.map((r) => [r.target, r.kind]),
    [['authors', 'many_to_one']],
    'relations to skipped tables are dropped',
  );
  assert.deepEqual(
    client.calls
      .filter((c) => c.values.length)
      .every((c) => c.values[0] === 'public'),
    true,
  );
});
