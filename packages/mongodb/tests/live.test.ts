/**
 * Runs the shared conformance suite against a REAL MongoDB-compatible server.
 *
 *   SETHUCMS_TEST_MONGO_URL=mongodb://localhost:27017 pnpm --filter @sethucms/adapter-mongodb test
 *
 * Without that variable these tests are skipped. Each run uses a temporary database and drops it afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineCollection, parseQuery, isSethuError } from '@sethucms/core';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import { MongoAdapter } from '../src/index.js';

const url = process.env['SETHUCMS_TEST_MONGO_URL'];
const skip = url ? false : 'set SETHUCMS_TEST_MONGO_URL to run';
// Skipped, not failed, when no server is configured, so CI without Mongo
// stays green.
const liveTest = (name: string, run: () => Promise<void>) =>
  test(name, { skip }, run);

function connection(database: string, readOnly: boolean) {
  const parsed = new URL(url!);
  return {
    connectionId: 'live',
    config: {
      host: parsed.hostname,
      port: Number(parsed.port || 27017),
      database,
      tls: false,
    },
    credentials: {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    },
    readOnly,
  };
}
const newName = () => `conf_${randomBytes(6).toString('hex')}`;

// Reaches into the adapter's private handle on purpose: tests need
// dropDatabase, which the adapter deliberately does not expose.
async function drop(database: string) {
  const adapter = new MongoAdapter();
  await adapter.connect(connection(database, false));
  const handle = (
    adapter as unknown as {
      handle: { db: { dropDatabase(): Promise<unknown> } };
    }
  ).handle;
  await handle.db.dropDatabase();
  await adapter.close();
}

// The shared SDK conformance suite: every adapter must pass the same
// behavioural contract (CRUD, paging, filters, read-only, errors).
defineConformanceSuite(liveTest, {
  label: 'mongodb (live)',
  async prepare({ readOnly }) {
    const database = newName();
    const setup = new MongoAdapter();
    await setup.connect(connection(database, false));
    await setup.createCollection(conformanceCollection);
    await setup.close();
    const adapter = new MongoAdapter();
    await adapter.connect(connection(database, readOnly));
    return {
      adapter,
      cleanup: async () => {
        await adapter.close();
        await drop(database);
      },
    };
  },
});

// Fixtures: an integer key (counter-numbered) and a string key (ObjectId).
const authors = defineCollection({
  name: 'authors',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'name', type: 'string', required: true },
  ],
});
const notes = defineCollection({
  name: 'notes',
  fields: [
    { name: 'id', type: 'string', primaryKey: true, generated: true },
    { name: 'body', type: 'text' },
    { name: 'tags', type: 'array' },
    { name: 'meta', type: 'json' },
    { name: 'live', type: 'boolean' },
    { name: 'at', type: 'datetime' },
    { name: 'on', type: 'date' },
    { name: 'price', type: 'decimal' },
    { name: 'cover', type: 'binary' },
  ],
});

liveTest(
  'mongodb (live): created collections keep their types; ids are numbered or ObjectIds; every type round-trips',
  async () => {
    const database = newName();
    const adapter = new MongoAdapter();
    try {
      await adapter.connect(connection(database, false));
      await adapter.createCollection(authors);
      await adapter.createCollection(notes);
      await assert.rejects(
        adapter.createCollection(notes),
        (e) => isSethuError(e) && e.code === 'CONFLICT',
      );

      const found = await adapter.introspect();
      assert.deepEqual(found.map((c) => c.name).sort(), ['authors', 'notes']); // no internal collections
      const a = found.find((c) => c.name === 'authors')!;
      const n = found.find((c) => c.name === 'notes')!;
      assert.equal(n.fields.find((f) => f.name === 'live')!.type, 'boolean'); // from the saved definition, not guessed

      assert.equal((await adapter.create(a, { name: 'one' }))['id'], 1);
      assert.equal((await adapter.create(a, { name: 'two' }))['id'], 2);
      await adapter.create(a, { id: 50, name: 'copied' });
      await adapter.finishBulkLoad(a);
      assert.equal((await adapter.create(a, { name: 'next' }))['id'], 51);
      await assert.rejects(
        adapter.create(a, { id: 50, name: 'dup' }),
        (e) => isSethuError(e) && e.code === 'CONFLICT',
      );

      const created = await adapter.create(n, {
        body: 'hello',
        tags: ['x', 'y'],
        meta: { n: [1, 2] },
        live: true,
        at: '2024-05-06T07:08:09.000Z',
        on: '2024-05-06',
        price: 12.5,
        cover: Buffer.from('hi').toString('base64'),
      });
      assert.match(String(created['id']), /^[0-9a-f]{24}$/);
      const read = await adapter.get(n, String(created['id']));
      assert.deepEqual(read, created);
      assert.equal(read!['live'], true);
      assert.equal(read!['at'], '2024-05-06T07:08:09.000Z');
      assert.equal(read!['on'], '2024-05-06');
      assert.equal(
        Buffer.from(read!['cover'] as string, 'base64').toString(),
        'hi',
      );

      const hit = await adapter.find(
        n,
        parseQuery({
          collection: 'notes',
          filter: { field: 'tags', op: 'contains', value: 'y' },
        }),
        undefined,
      );
      assert.equal(hit.records.length, 1);
      assert.equal(
        (
          await adapter.find(
            n,
            parseQuery({
              collection: 'notes',
              filter: { field: 'body', op: 'contains', value: 'ELL' },
            }),
            undefined,
          )
        ).records.length,
        1,
      );

      // ids that match nothing: must read as "not found", not a driver error
      assert.equal(await adapter.get(a, 'abc'), null);
      assert.equal(await adapter.get(n, 'zzz'), null);
      await assert.rejects(
        adapter.update(a, '999', { name: 'x' }),
        (e) => isSethuError(e) && e.code === 'NOT_FOUND',
      );

      // json cannot smuggle operators into the document (live injection guard)
      await assert.rejects(
        adapter.create(n, { meta: { $set: { x: 1 } } }),
        (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
      );
    } finally {
      await adapter.close();
      await drop(database);
    }
  },
);

liveTest(
  'mongodb (live): a collection made outside SethuCMS is read from sample documents, and a declared definition wins',
  async () => {
    const database = newName();
    const adapter = new MongoAdapter();
    try {
      await adapter.connect(connection(database, false));
      const handle = (
        adapter as unknown as {
          handle: {
            db: {
              collection(n: string): {
                insertMany(d: unknown[]): Promise<unknown>;
              };
            };
          };
        }
      ).handle;
      await handle.db.collection('events').insertMany([
        { name: 'a', n: 1, at: new Date('2024-01-01T00:00:00Z') },
        { name: 'b', n: 2.5 },
      ]);
      const found = await adapter.introspect();
      const events = found.find((c) => c.name === 'events')!;
      assert.equal(events.fields.find((f) => f.name === 'n')!.type, 'decimal');
      assert.equal(
        events.fields.find((f) => f.name === 'at')!.type,
        'datetime',
      );
      const all = await adapter.find(
        events,
        parseQuery({ collection: 'events' }),
        undefined,
      );
      assert.equal(all.records.length, 2);
      assert.equal(all.records[1]!['at'], null); // missing fields read as null
      assert.match(String(all.records[0]!['_id']), /^[0-9a-f]{24}$/);
      await adapter.close();

      const declared = new MongoAdapter();
      await declared.connect({
        ...connection(database, false),
        config: {
          ...connection(database, false).config,
          collections: [
            {
              name: 'events',
              fields: [
                {
                  name: 'id',
                  type: 'string',
                  primaryKey: true,
                  generated: true,
                },
                { name: 'name', type: 'string' },
              ],
            },
          ],
        },
      });
      const redefined = (await declared.introspect()).find(
        (c) => c.name === 'events',
      )!;
      assert.deepEqual(
        redefined.fields.map((f) => f.name),
        ['id', 'name'],
      );
      assert.equal(
        (
          await declared.find(
            redefined,
            parseQuery({ collection: 'events' }),
            undefined,
          )
        ).records.length,
        2,
      );
      await declared.close();
    } finally {
      await adapter.close();
      await drop(database);
    }
  },
);

liveTest(
  'mongodb (live): a read-only connection refuses every write',
  async () => {
    const database = newName();
    const rw = new MongoAdapter();
    const ro = new MongoAdapter();
    try {
      await rw.connect(connection(database, false));
      await rw.createCollection(authors);
      await ro.connect(connection(database, true));
      await assert.rejects(
        ro.create(authors, { name: 'x' }),
        (e) => isSethuError(e) && e.code === 'READ_ONLY',
      );
      await assert.rejects(
        ro.createCollection(notes),
        (e) => isSethuError(e) && e.code === 'READ_ONLY',
      );
      await assert.rejects(
        ro.delete(authors, '1'),
        (e) => isSethuError(e) && e.code === 'READ_ONLY',
      );
    } finally {
      await rw.close();
      await ro.close();
      await drop(database);
    }
  },
);
