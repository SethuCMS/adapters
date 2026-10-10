/**
 * Tests for the Firestore adapter: the shared conformance suite plus Firestore-
 * specific behaviour (id mapping, counters, query limits, scan cap), run
 * against an in-memory fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineCollection, parseQuery, isSethuError } from '@sethucms/core';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import {
  FirestoreAdapter,
  parseSettings,
  compileFilter,
  assertValidDocumentId,
  assertStorable,
  mapFirestoreError,
  inferCollection,
} from '../src/index.js';
import { createFakeFirestore } from './helpers/fake-firestore.js';

// Minimal valid connection input for the fake.
const input = (readOnly = false) => ({
  connectionId: 'c',
  config: { projectId: 'demo-project' },
  credentials: {},
  readOnly,
});

// The shared suite, against the in-memory fake (see the note in the fake: this is not proof for real Firestore).
defineConformanceSuite(test, {
  label: 'firestore (fake)',
  async prepare({ readOnly }) {
    const fake = createFakeFirestore();
    const setup = new FirestoreAdapter({ clientFactory: async () => fake });
    await setup.connect(input(false));
    await setup.createCollection(conformanceCollection);
    const adapter = new FirestoreAdapter({ clientFactory: async () => fake });
    await adapter.connect(input(readOnly));
    return { adapter };
  },
});

// Fixture covering every canonical type the adapter must round-trip.
const notes = defineCollection({
  name: 'notes',
  fields: [
    { name: 'id', type: 'string', primaryKey: true, generated: true },
    { name: 'title', type: 'string' },
    { name: 'body', type: 'text' },
    { name: 'tags', type: 'array' },
    { name: 'meta', type: 'json' },
    { name: 'at', type: 'datetime' },
    { name: 'cover', type: 'binary' },
    { name: 'n', type: 'integer' },
  ],
});
const q = (extra: object = {}) => parseQuery({ collection: 'notes', ...extra });

async function open() {
  const fake = createFakeFirestore();
  const adapter = new FirestoreAdapter({ clientFactory: async () => fake });
  await adapter.connect(input());
  return { adapter, fake };
}

test('string ids: auto ids, explicit ids, conflicts, and every type round-trips', async () => {
  const { adapter } = await open();
  await adapter.createCollection(notes);
  const created = await adapter.create(notes, {
    title: 'T',
    body: 'hello',
    tags: ['a'],
    meta: { x: [1] },
    at: '2024-05-06T07:08:09.000Z',
    cover: Buffer.from('hi').toString('base64'),
    n: 3,
  });
  assert.ok(String(created['id']).length > 5);
  assert.deepEqual(await adapter.get(notes, String(created['id'])), created);

  const explicit = await adapter.create(notes, { id: 'my-note', title: 'x' });
  assert.equal(explicit['id'], 'my-note');
  assert.equal(explicit['body'], null);
  await assert.rejects(
    adapter.create(notes, { id: 'my-note' }),
    (e) => isSethuError(e) && e.code === 'CONFLICT',
  );
  await assert.rejects(
    adapter.create(notes, { id: 'a/b' }),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
  assert.equal(await adapter.get(notes, 'a/b'), null);
  assert.equal(await adapter.get(notes, '..'), null);
  await assert.rejects(
    adapter.update(notes, 'nope', { title: 'x' }),
    (e) => isSethuError(e) && e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    adapter.delete(notes, 'nope'),
    (e) => isSethuError(e) && e.code === 'NOT_FOUND',
  );
  assert.equal(
    (await adapter.update(notes, 'my-note', { title: 'y' }))['title'],
    'y',
  );
});

test('integer ids are numbered from a counter that stays past explicit ids', async () => {
  const { adapter } = await open();
  await adapter.createCollection(conformanceCollection);
  assert.equal(
    (await adapter.create(conformanceCollection, { title: 'a' }))['id'],
    1,
  );
  assert.equal(
    (await adapter.create(conformanceCollection, { id: 50, title: 'copied' }))[
      'id'
    ],
    50,
  );
  assert.equal(
    (await adapter.create(conformanceCollection, { title: 'next' }))['id'],
    51,
  );
  await assert.rejects(
    adapter.create(conformanceCollection, { id: 50, title: 'dup' }),
    (e) => isSethuError(e) && e.code === 'CONFLICT',
  );
  assert.equal(
    (await adapter.create(conformanceCollection, { title: 'after-failed' }))[
      'id'
    ],
    52,
  );
  assert.equal(
    (await adapter.get(conformanceCollection, '50'))!['title'],
    'copied',
  );
});

// Unsupported queries must fail loudly (CAPABILITY_UNSUPPORTED) rather than
// return approximate results; `ne` must still include null, as in SQL.
test('queries Firestore cannot run are refused; null-safe not-equal works; startsWith is a prefix range', async () => {
  const { adapter } = await open();
  await adapter.createCollection(notes);
  await adapter.create(notes, { id: 'a', title: 'Alpha', n: 1, tags: ['x'] });
  await adapter.create(notes, { id: 'b', title: 'Beta', n: null });
  await adapter.create(notes, { id: 'c', title: 'alpine', n: 3 });
  const ids = async (extra: object) =>
    (await adapter.find(notes, q(extra), undefined)).records.map(
      (r) => r['id'],
    );

  assert.deepEqual(
    await ids({ filter: { field: 'title', op: 'contains', value: 'LPH' } }),
    ['a'],
  ); // text search reads the collection and filters here, ignoring case
  assert.deepEqual(
    await ids({
      filter: {
        and: [
          { field: 'title', op: 'contains', value: 'al' },
          { field: 'n', op: 'gte', value: 2 },
        ],
      },
    }),
    ['c'],
  );
  assert.deepEqual(
    await ids({ filter: { field: 'tags', op: 'contains', value: 'x' } }),
    ['a'],
  );
  assert.deepEqual(
    await ids({ filter: { field: 'title', op: 'startsWith', value: 'Al' } }),
    ['a'],
  ); // case-sensitive
  assert.deepEqual(
    (await ids({ filter: { field: 'n', op: 'ne', value: 1 } })).sort(),
    ['b', 'c'],
  ); // includes the null one
  assert.deepEqual(
    await ids({ filter: { field: 'n', op: 'exists', value: false } }),
    ['b'],
  );
  assert.deepEqual(
    await ids({ filter: { not: { field: 'n', op: 'gt', value: 1 } } }),
    ['a'],
  );
  assert.deepEqual(
    await ids({ filter: { field: 'n', op: 'in', value: [1, null] } }).then(
      (r) => r.sort(),
    ),
    ['a', 'b'],
  );
  await assert.rejects(
    adapter.find(
      notes,
      q({
        filter: {
          field: 'n',
          op: 'in',
          value: Array.from({ length: 31 }, (_, i) => i),
        },
      }),
      undefined,
    ),
    (e) => isSethuError(e) && e.code === 'CAPABILITY_UNSUPPORTED',
  );
});

// Offset paging via limit+1: the extra row is the only "has more" signal.
test('pages by offset, one extra row tells whether there is more', async () => {
  const { adapter } = await open();
  await adapter.createCollection(notes);
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    await adapter.create(notes, { id, title: id });
  }
  const first = await adapter.find(notes, q({ page: { limit: 2 } }), undefined);
  assert.deepEqual(
    first.records.map((r) => r['id']),
    ['a', 'b'],
  );
  const second = await adapter.find(
    notes,
    q({ page: { limit: 2 } }),
    first.nextPosition,
  );
  assert.deepEqual(
    second.records.map((r) => r['id']),
    ['c', 'd'],
  );
  const last = await adapter.find(
    notes,
    q({ page: { limit: 2 } }),
    second.nextPosition,
  );
  assert.deepEqual(
    last.records.map((r) => r['id']),
    ['e'],
  );
  assert.equal(last.nextPosition, undefined);
});

test('collections made outside SethuCMS are guessed from samples; internal collections stay hidden', async () => {
  const { adapter, fake } = await open();
  fake.store.set(
    'events',
    new Map([
      ['1', { name: 'a', n: 1 }],
      ['2', { name: 'b', n: 2.5, at: new Date() }],
    ]),
  );
  await adapter.createCollection(notes);
  const found = await adapter.introspect();
  assert.deepEqual(found.map((c) => c.name).sort(), ['events', 'notes']);
  const events = found.find((c) => c.name === 'events')!;
  assert.equal(events.fields.find((f) => f.name === 'n')!.type, 'decimal');
  assert.equal(events.fields.find((f) => f.name === 'at')!.type, 'datetime');
  assert.equal(events.fields[0]!.name, 'id');
  assert.equal(inferCollection('bad-name', []), undefined);
});

test('read-only connections refuse every write', async () => {
  const fake = createFakeFirestore();
  const rw = new FirestoreAdapter({ clientFactory: async () => fake });
  await rw.connect(input());
  await rw.createCollection(notes);
  const ro = new FirestoreAdapter({ clientFactory: async () => fake });
  await ro.connect(input(true));
  for (const run of [
    () => ro.create(notes, { title: 'x' }),
    () => ro.update(notes, 'a', { title: 'x' }),
    () => ro.delete(notes, 'a'),
    () => ro.createCollection(conformanceCollection),
  ]) {
    await assert.rejects(
      run(),
      (e) => isSethuError(e) && e.code === 'READ_ONLY',
    );
  }
});

// Firestore rejects nested arrays and `__x__` keys; we catch them early
// with a clear validation error.
test('stored values: nested arrays and odd keys are refused', () => {
  assert.throws(() => assertStorable([[1]]));
  assert.throws(() => assertStorable({ __bad__: 1 }));
  assert.doesNotThrow(() => assertStorable({ a: [1, { b: [2] }] }));
  assert.throws(() => assertValidDocumentId('__x__'));
  assert.throws(() => assertValidDocumentId(''));
  assert.doesNotThrow(() => assertValidDocumentId('abc-123'));
});

// Injection/shape guard: object values are never allowed in filters.
test('filter values cannot be objects', () => {
  const F = {
    where: (...a: unknown[]) => a,
    and: (...a: unknown[]) => a,
    or: (...a: unknown[]) => a,
  };
  assert.throws(
    () =>
      compileFilter(notes, { field: 'title', op: 'eq', value: { a: 1 } }, F),
    (e) => isSethuError(e),
  );
  assert.throws(
    () => compileFilter(notes, { field: 'nope', op: 'eq', value: 1 }, F),
    (e) => isSethuError(e),
  );
});

// Only gRPC codes may influence the mapped error, never driver text.
test('errors become platform errors without driver text', () => {
  assert.equal(
    mapFirestoreError({
      code: 6,
      message: 'doc projects/p/documents/users/alice exists',
    }).code,
    'CONFLICT',
  );
  assert.equal(mapFirestoreError({ code: 7 }).code, 'FORBIDDEN');
  assert.equal(mapFirestoreError({ code: 16 }).code, 'AUTH_FAILED');
  assert.equal(mapFirestoreError({ code: 9 }).code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(mapFirestoreError({ code: 14 }).code, 'CONNECTION_FAILED');
  assert.doesNotMatch(
    mapFirestoreError({ code: 6, message: 'users/alice' }).message,
    /alice/,
  );
});

test('settings are checked and the service account key is never echoed', () => {
  assert.equal(parseSettings(input()).databaseId, '(default)');
  const key = JSON.stringify({
    client_email: 'a@b.iam.gserviceaccount.com',
    private_key: 'SECRETKEY',
  });
  assert.equal(
    parseSettings({ ...input(), credentials: { serviceAccount: key } })
      .serviceAccount?.client_email,
    'a@b.iam.gserviceaccount.com',
  );
  assert.throws(
    () =>
      parseSettings({
        ...input(),
        config: { projectId: 'X' },
        credentials: { serviceAccount: '{"private_key":"SECRETKEY"}' },
      }),
    (e) => isSethuError(e) && !e.message.includes('SECRETKEY'),
  );
});

// Scan cap: a big collection must refuse, not silently read everything.
test('text search is refused past the document cap, never made silently slow', async () => {
  const fake = createFakeFirestore();
  const adapter = new FirestoreAdapter({ clientFactory: async () => fake });
  await adapter.connect({
    ...input(),
    config: { projectId: 'demo-project', maxScanDocuments: 10 },
  });
  await adapter.createCollection(notes);
  for (let i = 0; i < 11; i += 1) {
    await adapter.create(notes, { id: `n${i}`, title: `note ${i}` });
  }
  await assert.rejects(
    adapter.find(
      notes,
      q({ filter: { field: 'title', op: 'contains', value: 'note' } }),
      undefined,
    ),
    (e) => isSethuError(e) && e.code === 'CAPABILITY_UNSUPPORTED',
  );
  assert.equal(
    (
      await adapter.find(
        notes,
        q({ filter: { field: 'title', op: 'startsWith', value: 'note 1' } }),
        undefined,
      )
    ).records.length,
    2,
  );
});
