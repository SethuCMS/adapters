import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineCollection, parseQuery } from '@sethucms/core';
import { compileFind } from '../src/translate.js';
import { mustScan } from '../src/scan.js';

const notes = defineCollection({
  name: 'notes',
  fields: [
    { name: 'id', type: 'string', primaryKey: true, generated: true },
    { name: 'title', type: 'string' },
    { name: 'n', type: 'integer' },
    { name: 'status', type: 'string' },
  ],
});
const q = (extra: object = {}) => parseQuery({ collection: 'notes', ...extra });
const F = {
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  and: (...parts: unknown[]) => ({ and: parts }),
  or: (...parts: unknown[]) => ({ or: parts }),
};

// Firestore only accepts a range/inequality filter when the first sort is on that same field.
test('a range filter leads the sort, so Firestore accepts the query', () => {
  const prefix = q({ filter: { field: 'title', op: 'startsWith', value: 'Be' } });
  assert.equal(mustScan(notes, prefix), false);
  assert.deepEqual(compileFind(notes, prefix, F).orderBy, [
    ['title', 'asc'],
    ['__name__', 'asc'],
  ]);

  const range = q({ filter: { field: 'n', op: 'gte', value: 20 } });
  assert.deepEqual(compileFind(notes, range, F).orderBy[0], ['n', 'asc']);

  const equalityOnly = q({ filter: { field: 'status', op: 'eq', value: 'open' } });
  assert.deepEqual(compileFind(notes, equalityOnly, F).orderBy, [['__name__', 'asc']]);
});

test('a sort on another field, or several range fields, is answered by a scan', () => {
  const sorted = q({
    filter: { field: 'n', op: 'gte', value: 20 },
    sort: [{ field: 'title', dir: 'asc' }],
  });
  assert.equal(mustScan(notes, sorted), true);

  const sameField = q({
    filter: { field: 'n', op: 'gte', value: 20 },
    sort: [{ field: 'n', dir: 'desc' }],
  });
  assert.equal(mustScan(notes, sameField), false);

  const two = q({
    filter: {
      and: [
        { field: 'n', op: 'gte', value: 1 },
        { field: 'title', op: 'startsWith', value: 'A' },
      ],
    },
  });
  assert.equal(mustScan(notes, two), true);

  const notEqual = q({ filter: { field: 'n', op: 'ne', value: 1 } });
  assert.equal(mustScan(notes, notEqual), true);
});

// "Newest first" must not need a hand-made composite index: the id tie-break follows the sort direction.
test('the id tie-break follows the direction of the last sort', () => {
  const newest = q({ sort: [{ field: 'title', dir: 'desc' }] });
  assert.deepEqual(compileFind(notes, newest, F).orderBy, [
    ['title', 'desc'],
    ['__name__', 'desc'],
  ]);
  const oldest = q({ sort: [{ field: 'title', dir: 'asc' }] });
  assert.deepEqual(compileFind(notes, oldest, F).orderBy, [
    ['title', 'asc'],
    ['__name__', 'asc'],
  ]);
  const none = q();
  assert.deepEqual(compileFind(notes, none, F).orderBy, [['__name__', 'asc']]);
});
