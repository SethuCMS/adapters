/**
 * The real SQLite client, backed by `node:sqlite` (built into Node 22.5+).
 *
 * The driver is synchronous, which is fine here: SQLite runs inside the
 * gateway process, and each statement is short. Foreign keys are switched on
 * (SQLite leaves them off by default) and read-only connections are opened
 * read-only at the file level.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';
import type { SqlClient } from '@sethucms/adapter-sql-kit';
import { parseSettings } from './settings.js';

/**
 * Builds a client from connection input and the gateway's base folder; tests
 * supply a fake one.
 */
export type SqlClientFactory = (
  input: ConnectInput,
  baseDir: string | undefined,
) => Promise<SqlClient>;

/**
 * Open the database file (or memory) and wrap it as a SqlClient. Settings are
 * validated first, so the path is already confined to the base folder.
 */
export const createSqliteClient: SqlClientFactory = async (input, baseDir) => {
  const settings = parseSettings(input, baseDir);

  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    // A variable name keeps the built-in module load lazy, so older Node
    // versions get a clear error instead of an import failure.
    const moduleName = 'node:sqlite';
    ({ DatabaseSync } = await import(moduleName));
  } catch {
    throw errors.internal(
      'This Node.js version has no built-in SQLite (Node 22.5 or newer is needed)',
    );
  }

  const memory = settings.path === ':memory:';
  // Create the folder for a new file database; never touch disk when
  // read-only.
  if (!memory && !input.readOnly) {
    mkdirSync(dirname(settings.path), { recursive: true });
  }

  // Read-only is applied at file-open level; query_only below is a second
  // layer. In-memory databases have no file to open read-only.
  const db = new DatabaseSync(settings.path, {
    readOnly: input.readOnly && !memory,
  });
  try {
    // PRAGMAs cannot take bound parameters; the value is a validated integer.
    db.exec(`PRAGMA busy_timeout = ${settings.busyTimeoutMs}`);
    // SQLite ignores foreign keys unless asked, per connection.
    db.exec('PRAGMA foreign_keys = ON');
    if (input.readOnly) {
      db.exec('PRAGMA query_only = ON');
    }
    if (!memory && !input.readOnly) {
      // WAL lets readers and a writer work at once (not applicable in memory).
      db.exec('PRAGMA journal_mode = WAL');
    }
  } catch (error) {
    // Do not leak the file handle if setup fails.
    db.close();
    throw error;
  }

  return {
    async query(text, values) {
      // node:sqlite is synchronous. prepare() + bound values means parameters
      // never mix with the SQL text. Rows are copied to plain objects.
      const rows = db
        .prepare(text)
        .all(...((values ?? []) as never[])) as Array<Record<string, unknown>>;
      return { rows: rows.map((row) => ({ ...row })) };
    },
    async close() {
      if (db.isOpen) {
        db.close();
      }
    },
  };
};
