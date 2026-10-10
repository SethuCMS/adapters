/**
 * Runs the shared conformance suite against a real SQLite database (the one
 * built into Node), once in memory and once as a file in a temp folder.
 */
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import { SqliteAdapter } from '../src/index.js';

for (const where of ['memory', 'file'] as const) {
  defineConformanceSuite(test, {
    label: `sqlite (${where})`,
    async prepare({ readOnly }) {
      const dir = mkdtempSync(join(tmpdir(), 'sethucms-sqlite-'));
      const path = where === 'memory' ? ':memory:' : 'conf.db';
      const base = { connectionId: 'c', config: { path }, credentials: {} };

      // A file database is created by a writer first, then opened (possibly
      // read-only) by the adapter under test, since read-only cannot create
      // tables.
      const writer = new SqliteAdapter({ baseDir: dir });
      await writer.connect({ ...base, readOnly: false });
      const create = async (adapter: SqliteAdapter) =>
        adapter.createCollection(conformanceCollection);
      let adapter = writer;
      await create(writer);
      if (where === 'file' && readOnly) {
        await writer.close();
        adapter = new SqliteAdapter({ baseDir: dir });
        await adapter.connect({ ...base, readOnly: true });
      }
      return {
        adapter,
        cleanup: async () => {
          await adapter.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  });
}
