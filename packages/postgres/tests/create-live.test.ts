/**
 * Table creation and id-counter repair against a REAL PostgreSQL server
 * (skipped without SETHUCMS_TEST_PG_URL).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineCollection, isSethuError } from '@sethucms/core';
import { PostgresAdapter, createPgClient } from '../src/index.js';

const url = process.env['SETHUCMS_TEST_PG_URL'];
const skip = url ? false : 'set SETHUCMS_TEST_PG_URL to run';

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
    { name: 'at', type: 'datetime' },
  ],
});

test(
  'postgres: creates tables, keeps ids, then continues numbering after finishBulkLoad',
  { skip },
  async () => {
    const parsed = new URL(url!);
    // Random schema per run; dropped in the finally block below.
    const schema = `cc_${randomBytes(6).toString('hex')}`;
    const base = {
      connectionId: 'c',
      credentials: {
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      },
      readOnly: false,
    };
    const config = {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: parsed.pathname.slice(1),
      schema,
      ssl: false,
    };
    const admin = await createPgClient({
      ...base,
      config: { ...config, schema: 'public' },
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const adapter = new PostgresAdapter();
    try {
      await adapter.connect({ ...base, config });
      await adapter.createCollection(authors);
      await adapter.createCollection(books);
      await assert.rejects(
        adapter.createCollection(books),
        (e) => isSethuError(e) && e.code === 'CONFLICT',
      );

      const found = await adapter.introspect();
      const b = found.find((c) => c.name === 'books')!;
      assert.equal(b.relations[0]?.target, 'authors');
      assert.equal(b.fields.find((f) => f.name === 'id')!.generated, true);

      const a = found.find((c) => c.name === 'authors')!;
      await adapter.create(a, { id: 100, name: 'copied' });
      await adapter.create(b, {
        id: 7,
        title: 't',
        author: 100,
        tags: ['a'],
        meta: { x: 1 },
        at: '2024-01-02T03:04:05.000Z',
      });
      // Without repair the counter would hand out id 1 and, later, collide.
      await adapter.finishBulkLoad(a);
      assert.equal((await adapter.create(a, { name: 'next' }))['id'], 101);
      assert.deepEqual((await adapter.get(b, '7'))!['tags'], ['a']);
      await adapter.finishBulkLoad(b); // also fine on a table with one row
      await adapter.finishBulkLoad(authors); // and on an empty-or-not table: no error
    } finally {
      await adapter.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  },
);
