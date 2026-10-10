/**
 * Tests for the SQLite adapter on in-memory and temp-file databases: path
 * confinement in settings, declared-type mapping, table creation and
 * introspection, type round-trips, id/unique handling, and error hygiene.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCollection, parseQuery, isSethuError } from '@sethucms/core';
import { SqliteAdapter, parseSettings, mapSqliteType } from '../src/index.js';

// Builds the ConnectInput the adapter expects; SQLite needs no credentials.
const input = (config: Record<string, unknown>, readOnly = false) => ({
  connectionId: 'c',
  config,
  credentials: {},
  readOnly,
});

test('paths: only :memory: or a file inside the base folder', () => {
  const base = '/srv/sethu/sqlite';
  assert.equal(
    parseSettings(input({ path: ':memory:' }), undefined).path,
    ':memory:',
  );
  assert.equal(
    parseSettings(input({ path: 'a.db' }), base).path,
    '/srv/sethu/sqlite/a.db',
  );
  for (const bad of [
    '../x.db',
    '/etc/passwd',
    'a/../../x',
    '',
    'file:/etc/x?mode=ro',
    'a\0b',
    base,
    '..',
  ]) {
    assert.throws(
      () => parseSettings(input({ path: bad }), base),
      (e) => isSethuError(e),
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => parseSettings(input({ path: 'a.db' }), undefined),
    /SETHUCMS_SQLITE_DIR/,
  );
  assert.throws(() =>
    parseSettings(input({ path: ':memory:', busyTimeoutMs: -1 }), base),
  );
});

test('type names map the way SQLite reads them', () => {
  assert.equal(mapSqliteType('INTEGER').type, 'integer');
  assert.equal(mapSqliteType('BIGINT').type, 'integer');
  assert.equal(mapSqliteType('VARCHAR(20)').type, 'string');
  assert.equal(mapSqliteType('TEXT').type, 'text');
  assert.equal(mapSqliteType('BOOLEAN').type, 'boolean');
  assert.equal(mapSqliteType('DATETIME').type, 'datetime');
  assert.equal(mapSqliteType('DATE').type, 'date');
  assert.equal(mapSqliteType('BLOB').type, 'binary');
  assert.equal(mapSqliteType('NUMERIC').type, 'decimal');
  assert.deepEqual(mapSqliteType(''), { type: 'string', lossy: true });
});

// A fresh in-memory adapter; nothing touches the disk.
async function open() {
  const adapter = new SqliteAdapter();
  await adapter.connect(input({ path: ':memory:' }));
  return adapter;
}

const authors = defineCollection({
  name: 'authors',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'name', type: 'string', required: true },
  ],
});
const books = defineCollection({
  name: 'books',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'title', type: 'string', required: true },
    { name: 'author', type: 'reference', references: 'authors' },
    { name: 'tags', type: 'array' },
    { name: 'meta', type: 'json' },
    { name: 'live', type: 'boolean' },
    { name: 'published', type: 'datetime' },
    { name: 'cover', type: 'binary' },
    { name: 'price', type: 'decimal' },
  ],
});

test('creates tables, reads them back with types and foreign keys, and round-trips every type', async () => {
  const adapter = await open();
  await adapter.createCollection(authors);
  await adapter.createCollection(books);

  const found = await adapter.introspect();
  const b = found.find((c) => c.name === 'books')!;
  assert.deepEqual(found.map((c) => c.name).sort(), ['authors', 'books']);
  assert.equal(b.fields.find((f) => f.name === 'id')!.generated, true);
  assert.equal(b.fields.find((f) => f.name === 'title')!.required, true);
  assert.equal(b.fields.find((f) => f.name === 'live')!.type, 'boolean');
  assert.equal(b.relations[0]!.target, 'authors');

  const a = found.find((c) => c.name === 'authors')!;
  const author = await adapter.create(a, { name: 'Ada' });
  const created = await adapter.create(b, {
    title: 'T',
    author: author['id'],
    tags: ['x', 'y'],
    meta: { n: [1, 2] },
    live: true,
    published: '2024-05-06T07:08:09.000Z',
    cover: Buffer.from('hello').toString('base64'),
    price: 12.5,
  });
  const read = await adapter.get(b, String(created['id']));
  assert.deepEqual(read, created);
  assert.equal(read!['live'], true);
  assert.deepEqual(read!['tags'], ['x', 'y']);
  assert.deepEqual(read!['meta'], { n: [1, 2] });
  assert.equal(
    Buffer.from(read!['cover'] as string, 'base64').toString(),
    'hello',
  );

  // foreign keys are enforced
  await assert.rejects(
    adapter.create(b, { title: 'bad', author: 999 }),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );

  // array contains
  const hit = await adapter.find(
    b,
    parseQuery({
      collection: 'books',
      filter: { field: 'tags', op: 'contains', value: 'y' },
    }),
    undefined,
  );
  assert.equal(hit.records.length, 1);
  const miss = await adapter.find(
    b,
    parseQuery({
      collection: 'books',
      filter: { field: 'tags', op: 'contains', value: 'z' },
    }),
    undefined,
  );
  assert.equal(miss.records.length, 0);
  await adapter.close();
});

test('createCollection refuses an existing table, and a read-only connection', async () => {
  const adapter = await open();
  await adapter.createCollection(authors);
  await assert.rejects(
    adapter.createCollection(authors),
    (e) => isSethuError(e) && e.code === 'CONFLICT',
  );
  await adapter.close();

  const dir = mkdtempSync(join(tmpdir(), 'sethucms-ro-'));
  try {
    const rw = new SqliteAdapter({ baseDir: dir });
    await rw.connect(input({ path: 'x.db' }));
    await rw.createCollection(authors);
    await rw.close();
    const ro = new SqliteAdapter({ baseDir: dir });
    await ro.connect(input({ path: 'x.db' }, true));
    await assert.rejects(
      ro.createCollection(books),
      (e) => isSethuError(e) && e.code === 'READ_ONLY',
    );
    await assert.rejects(ro.create(authors, { name: 'x' }), (e) =>
      isSethuError(e),
    );
    await ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit ids are kept and unique violations become CONFLICT', async () => {
  const adapter = await open();
  await adapter.createCollection(authors);
  const created = await adapter.create(authors, { id: 42, name: 'x' });
  assert.equal(created['id'], 42);
  await assert.rejects(
    adapter.create(authors, { id: 42, name: 'y' }),
    (e) => isSethuError(e) && e.code === 'CONFLICT',
  );
  assert.equal((await adapter.create(authors, { name: 'z' }))['id'], 43);
  await adapter.close();
});

test('errors never include table names, SQL or file paths', async () => {
  const adapter = await open();
  await adapter.createCollection(authors);
  try {
    await adapter.create(authors, { id: 1, name: null as never });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(isSethuError(e));
    assert.doesNotMatch(e.message, /authors|INSERT|NOT NULL/);
  }
  await adapter.close();
});
