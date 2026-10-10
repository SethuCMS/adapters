/**
 * Runs the shared conformance suite against a REAL PostgreSQL server.
 *
 *   SETHUCMS_TEST_PG_URL=postgres://user:pass@localhost:5432/dbname \
 *     pnpm --filter @sethucms/adapter-postgres test
 *
 * Without that variable these tests are skipped. Each run uses a temporary
 * schema and removes it afterwards. Set SETHUCMS_TEST_DRIVER=psql to use the
 * `psql` tool instead of the `pg` package.
 */
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import {
  PostgresAdapter,
  createPgClient,
  type SqlClient,
  type SqlClientFactory,
} from '../src/index.js';
import { createPsqlClient } from './helpers/psql-client.js';

const url = process.env['SETHUCMS_TEST_PG_URL'];
const usePsql = process.env['SETHUCMS_TEST_DRIVER'] === 'psql';

// Skips (rather than fails) when no database URL is configured.
const liveTest = (name: string, run: () => Promise<void>) =>
  test(name, { skip: url ? false : 'set SETHUCMS_TEST_PG_URL to run' }, run);

defineConformanceSuite(liveTest, {
  label: 'postgres (live)',
  async prepare({ readOnly }) {
    if (!url) {
      throw new Error('unreachable');
    }
    const parsed = new URL(url);
    // A random schema per run isolates tests from each other and real data.
    const schema = `conf_${randomBytes(6).toString('hex')}`;

    const factory: SqlClientFactory = usePsql
      ? async () => createPsqlClient(url)
      : createPgClient;
    const connectInput = {
      connectionId: 'live',
      config: {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        database: parsed.pathname.slice(1),
        schema,
        ssl: false,
      },
      credentials: {
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      },
      readOnly,
    };

    // Set up the schema with a plain admin client, then connect the adapter
    // under test (which may be read-only and so cannot create tables).
    const admin: SqlClient = usePsql
      ? createPsqlClient(url)
      : await createPgClient({
          ...connectInput,
          config: { ...connectInput.config, schema: 'public' },
          readOnly: false,
        });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      `CREATE TABLE "${schema}"."${conformanceCollection.name}" (
         id serial PRIMARY KEY,
         title varchar(200) NOT NULL,
         score integer,
         status text
       )`,
    );

    const adapter = new PostgresAdapter({ clientFactory: factory });
    await adapter.connect(connectInput);
    return {
      adapter,
      cleanup: async () => {
        await adapter.close();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      },
    };
  },
});
