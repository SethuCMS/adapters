import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { isSethuError } from '@sethucms/core';
import { FirestoreAdapter, MAX_FILE_BYTES, PART_BYTES, isFileId } from '../src/index.js';
import { createFakeFirestore } from './helpers/fake-firestore.js';

const input = (readOnly = false) => ({
  connectionId: 'c',
  config: { projectId: 'demo-project' },
  credentials: {},
  readOnly,
});
async function open(readOnly = false) {
  const fake = createFakeFirestore();
  const adapter = new FirestoreAdapter({ clientFactory: async () => fake });
  await adapter.connect(input(readOnly));
  return { adapter, fake };
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);

test('a small file round-trips with its description', async () => {
  const { adapter } = await open();
  const meta = await adapter.putFile({ name: 'logo.png', contentType: 'image/png' }, png);
  assert.ok(isFileId(meta.id));
  assert.equal(meta.size, png.length);
  assert.equal(meta.sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(await adapter.getFileMeta(meta.id), meta);
  const read = await adapter.readFile(meta.id);
  assert.ok(read);
  assert.equal(read.meta.contentType, 'image/png');
  assert.ok(Buffer.compare(read.data, png) === 0);
});

test('a file larger than one part is cut into parts and put back together', async () => {
  const { adapter, fake } = await open();
  const big = randomBytes(PART_BYTES * 2 + 123);
  const meta = await adapter.putFile({ name: 'cv.pdf', contentType: 'application/pdf' }, big);
  assert.equal(fake.store.get('_sethucms_file_parts')?.size, 3);
  const read = await adapter.readFile(meta.id);
  assert.ok(read && Buffer.compare(read.data, big) === 0);
});

test('the largest allowed file works; one byte more, an empty file and a missing type are refused', async () => {
  const { adapter } = await open();
  const max = randomBytes(MAX_FILE_BYTES);
  const meta = await adapter.putFile({ name: 'max.pdf', contentType: 'application/pdf' }, max);
  assert.equal((await adapter.readFile(meta.id))?.data.length, MAX_FILE_BYTES);
  for (const [data, type] of [
    [randomBytes(MAX_FILE_BYTES + 1), 'application/pdf'],
    [Buffer.alloc(0), 'application/pdf'],
    [png, ''],
  ] as const) {
    await assert.rejects(
      adapter.putFile({ name: 'x', contentType: type }, data),
      (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
    );
  }
});

test('names are cleaned and unknown or malformed ids read as no file', async () => {
  const { adapter } = await open();
  const meta = await adapter.putFile({ name: 'a\r\nb\u0000.png', contentType: 'image/png' }, png);
  assert.equal(meta.name, 'ab.png');
  for (const id of ['', 'short', '../x', 'a/b', 'x'.repeat(22) + '!', '__proto__', 'A'.repeat(22)]) {
    assert.equal(await adapter.getFileMeta(id), null);
    assert.equal(await adapter.readFile(id), null);
    assert.equal(await adapter.deleteFile(id), false);
  }
});

test('delete removes the description and every part; a second delete says there was none', async () => {
  const { adapter, fake } = await open();
  const meta = await adapter.putFile({ name: 'cv.pdf', contentType: 'application/pdf' }, randomBytes(PART_BYTES + 5));
  assert.equal(await adapter.deleteFile(meta.id), true);
  assert.equal(await adapter.getFileMeta(meta.id), null);
  assert.equal(fake.store.get('_sethucms_file_parts')?.size ?? 0, 0);
  assert.equal(await adapter.deleteFile(meta.id), false);
});

test('a damaged or incomplete file is reported, not served', async () => {
  const { adapter, fake } = await open();
  const meta = await adapter.putFile({ name: 'cv.pdf', contentType: 'application/pdf' }, randomBytes(PART_BYTES + 5));
  const part = fake.store.get('_sethucms_file_parts')!.get(`${meta.id}_1`)!;
  part['data'] = new Uint8Array([1, 2, 3, 4, 5]); // same length, wrong bytes
  await assert.rejects(adapter.readFile(meta.id), (e) => isSethuError(e) && e.code === 'INTERNAL');
  fake.store.get('_sethucms_file_parts')!.delete(`${meta.id}_0`);
  await assert.rejects(adapter.readFile(meta.id), (e) => isSethuError(e) && e.code === 'INTERNAL');
});

test('a failed save leaves no parts behind', async () => {
  const { adapter, fake } = await open();
  // Make the description write fail, after the parts are already stored.
  const original = fake.db.collection.bind(fake.db);
  fake.db.collection = (name: string) => {
    const c = original(name);
    if (name === '_sethucms_files') {
      return { ...c, doc: (id?: string) => ({ ...c.doc(id), create: async () => { throw Object.assign(new Error('boom'), { code: 14 }); } }) };
    }
    return c;
  };
  await assert.rejects(adapter.putFile({ name: 'x.pdf', contentType: 'application/pdf' }, randomBytes(PART_BYTES + 10)));
  assert.equal(fake.store.get('_sethucms_file_parts')?.size ?? 0, 0);
});

test('a read-only connection refuses to store or delete, but can read', async () => {
  const writable = await open();
  const meta = await writable.adapter.putFile({ name: 'a.png', contentType: 'image/png' }, png);
  const ro = new FirestoreAdapter({ clientFactory: async () => writable.fake });
  await ro.connect(input(true));
  await assert.rejects(ro.putFile({ name: 'b.png', contentType: 'image/png' }, png), (e) => isSethuError(e) && e.code === 'READ_ONLY');
  await assert.rejects(ro.deleteFile(meta.id), (e) => isSethuError(e) && e.code === 'READ_ONLY');
  assert.ok(await ro.readFile(meta.id));
});

test('file collections never show up as content', async () => {
  const { adapter } = await open();
  await adapter.putFile({ name: 'a.png', contentType: 'image/png' }, png);
  assert.deepEqual((await adapter.introspect()).map((c) => c.name), []);
});
