/**
 * Runs the shared conformance suite against a REAL MySQL or MariaDB server,
 * plus type round-trips, id validation and read-only checks.
 *
 *   SETHUCMS_TEST_MYSQL_URL=mysql://user:pass@localhost:3306 \
 *     pnpm --filter @sethucms/adapter-mysql test
 *
 * Without that variable these tests are skipped. Each run uses a temporary
 * database and removes it afterwards (so the user needs CREATE and DROP
 * rights).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineCollection, parseQuery, isSethuError } from '@sethucms/core';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import { MysqlAdapter, createMysqlClient } from '../src/index.js';

const url = process.env['SETHUCMS_TEST_MYSQL_URL'];
// Skips (rather than fails) when no server URL is configured.
const skip = url ? false : 'set SETHUCMS_TEST_MYSQL_URL to run';
const liveTest = (name: string, run: () => Promise<void>) =>
  test(name, { skip }, run);

// A random database per test isolates runs. Returns connection inputs scoped
// to it, and a cleanup that drops it.
async function temporaryDatabase() {
  const parsed = new URL(url!);
  const database = `conf_${randomBytes(6).toString('hex')}`;
  const base = {
    connectionId: 'live',
    credentials: {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    },
  };
  const config = {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    ssl: false,
  };
  const admin = await createMysqlClient({
    ...base,
    config: { ...config, database: parsed.pathname.slice(1) || 'mysql' },
    readOnly: false,
  });
  await admin.query(`CREATE DATABASE \`${database}\``);
  return {
    connect: (readOnly: boolean) => ({
      ...base,
      config: { ...config, database },
      readOnly,
    }),
    cleanup: async () => {
      await admin.query(`DROP DATABASE \`${database}\``);
      await admin.close();
    },
  };
}

defineConformanceSuite(liveTest, {
  label: 'mysql (live)',
  async prepare({ readOnly }) {
    const db = await temporaryDatabase();
    const setup = new MysqlAdapter();
    await setup.connect(db.connect(false));
    await setup.createCollection(conformanceCollection);
    await setup.close();
    const adapter = new MysqlAdapter();
    await adapter.connect(db.connect(readOnly));
    return {
      adapter,
      cleanup: async () => {
        await adapter.close();
        await db.cleanup();
      },
    };
  },
});

// Fixtures: books reference authors and cover most canonical types.
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
    { name: 'at', type: 'datetime' },
    { name: 'price', type: 'decimal' },
    { name: 'cover', type: 'binary' },
  ],
});

liveTest(
  'mysql (live): creates tables, round-trips every type, keeps explicit ids, refuses bad ids',
  async () => {
    const db = await temporaryDatabase();
    const adapter = new MysqlAdapter();
    try {
      await adapter.connect(db.connect(false));
      await adapter.createCollection(authors);
      await adapter.createCollection(books);
      await assert.rejects(
        adapter.createCollection(books),
        (e) => isSethuError(e) && e.code === 'CONFLICT',
      );

      const found = await adapter.introspect();
      const b = found.find((c) => c.name === 'books')!;
      const a = found.find((c) => c.name === 'authors')!;
      assert.equal(b.relations[0]?.target, 'authors');
      assert.equal(b.fields.find((f) => f.name === 'id')!.generated, true);
      assert.equal(b.fields.find((f) => f.name === 'live')!.type, 'boolean');
      assert.equal(b.fields.find((f) => f.name === 'title')!.required, true);

      const kept = await adapter.create(a, { id: 100, name: 'copied' });
      assert.equal(kept['id'], 100);
      assert.equal((await adapter.create(a, { name: 'next' }))['id'], 101);

      const created = await adapter.create(b, {
        title: 'T',
        author: 100,
        tags: ['x', 'y'],
        meta: { n: [1, 2] },
        live: true,
        at: '2024-05-06T07:08:09.000Z',
        price: 12.5,
        cover: Buffer.from('hi').toString('base64'),
      });
      const read = await adapter.get(b, String(created['id']));
      assert.deepEqual(read, created);
      assert.equal(read!['live'], true);
      assert.deepEqual(read!['tags'], ['x', 'y']);
      assert.deepEqual(read!['meta'], { n: [1, 2] });
      assert.equal(read!['at'], '2024-05-06T07:08:09.000Z');
      assert.equal(Number(read!['price']), 12.5);

      // A bad id must not match record 0 or 1 (MySQL coerces "abc" to 0).
      assert.equal(await adapter.get(a, '100abc'), null);
      assert.equal(await adapter.get(a, 'abc'), null);
      await assert.rejects(
        adapter.update(a, '100abc', { name: 'x' }),
        (e) => isSethuError(e) && e.code === 'NOT_FOUND',
      );

      // Foreign keys are enforced; duplicate keys are a conflict.
      await assert.rejects(
        adapter.create(b, { title: 'bad', author: 999 }),
        (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
      );
      await assert.rejects(
        adapter.create(a, { id: 100, name: 'dup' }),
        (e) => isSethuError(e) && e.code === 'CONFLICT',
      );

      // Updating to the same values still counts as found (needs the driver's
      // FOUND_ROWS flag, else affectedRows would be 0).
      assert.equal(
        (await adapter.update(a, '100', { name: 'copied' }))['name'],
        'copied',
      );

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
    } finally {
      await adapter.close();
      await db.cleanup();
    }
  },
);

liveTest(
  'mysql (live): a read-only connection cannot create tables or write',
  async () => {
    const db = await temporaryDatabase();
    const rw = new MysqlAdapter();
    const ro = new MysqlAdapter();
    try {
      await rw.connect(db.connect(false));
      await rw.createCollection(authors);
      await ro.connect(db.connect(true));
      await assert.rejects(
        ro.createCollection(books),
        (e) => isSethuError(e) && e.code === 'READ_ONLY',
      );
      // The database itself must refuse the write too. Dolt (the stand-in used
      // in development) ignores read-only sessions, so that one check only
      // runs against a real MySQL or MariaDB server.
      const probe = await createMysqlClient({
        ...db.connect(false),
        config: { ...db.connect(false).config },
      });
      const comment = String(
        (await probe.query('SELECT @@version_comment AS v')).rows[0]?.['v'],
      );
      await probe.close();
      if (/dolt/i.test(comment)) {
        return;
      }
      await assert.rejects(
        ro.create(authors, { name: 'x' }),
        (e) => isSethuError(e) && e.code === 'READ_ONLY',
      );
    } finally {
      await rw.close();
      await ro.close();
      await db.cleanup();
    }
  },
);
