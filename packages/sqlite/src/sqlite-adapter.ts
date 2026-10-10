/**
 * The SQLite adapter. SQL is built by the shared sql-kit; this file connects
 * it to a SQLite file, reads the schema, and can create tables for migration.
 */
import {
  PRESETS,
  errors,
  type Capabilities,
  type CollectionDefinition,
  type Query,
} from '@sethucms/core';
import type {
  Adapter,
  ConnectInput,
  FindResult,
  RecordData,
} from '@sethucms/adapter-sdk';
import {
  buildCreateTable,
  buildDelete,
  buildGet,
  buildInsert,
  buildSelect,
  buildUpdate,
  normalizeRow,
  sqliteDialect,
  type CompiledSql,
  type SqlClient,
} from '@sethucms/adapter-sql-kit';
import { createSqliteClient, type SqlClientFactory } from './client.js';
import { mapSqliteError } from './errors.js';
import { introspectSchema } from './introspect.js';
import { parseSettings } from './settings.js';

// SQLite supports the same capability set as the other SQL databases.
const CAPABILITIES: Capabilities = PRESETS.sql;
// All SQL here comes from sql-kit with this dialect.
const dialect = sqliteDialect;

/** Options for constructing a SqliteAdapter. */
export interface SqliteAdapterOptions {
  /**
   * Folder that database files must live in. Without it only ':memory:'
   * databases are allowed.
   */
  baseDir?: string;
  /** Replace the real driver, for tests. */
  clientFactory?: SqlClientFactory;
}

/**
 * Adapter for SQLite files. RETURNING (SQLite 3.35+) lets writes return the
 * stored row directly, so no read-back is needed.
 */
export class SqliteAdapter implements Adapter {
  readonly type = 'sqlite';
  private client: SqlClient | undefined;
  private readOnly = false;
  private readonly baseDir: string | undefined;
  private readonly clientFactory: SqlClientFactory;

  constructor(options: SqliteAdapterOptions = {}) {
    this.baseDir = options.baseDir;
    this.clientFactory = options.clientFactory ?? createSqliteClient;
  }

  /** Validate settings, open the database, and prove it works. */
  async connect(input: ConnectInput): Promise<void> {
    // Fails early with a clear message.
    parseSettings(input, this.baseDir);
    this.readOnly = input.readOnly;
    try {
      this.client = await this.clientFactory(input, this.baseDir);
      await this.client.query('SELECT 1');
    } catch (error) {
      // Do not leave a half-open database behind after a failed connect.
      await this.close();
      throw mapSqliteError(error);
    }
  }

  /** The fixed capability set for SQL databases. */
  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** Discover the database's tables as collections. */
  async introspect(): Promise<CollectionDefinition[]> {
    return this.run(() => introspectSchema(this.connected()));
  }

  /**
   * List a page of records. `position` is the opaque offset from the previous
   * page; the guard layer signs it, so it is trusted here.
   */
  async find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult> {
    const offset = readOffset(position);
    const { rows } = await this.execute(
      buildSelect(dialect, this.target(collection), query, offset),
    );
    // The query asked for limit+1 rows; the extra one only proves a next page
    // exists and is not returned.
    const pageRows = rows.slice(0, query.page.limit);
    return {
      records: pageRows.map((row) => normalizeRow(collection, row)),
      ...(rows.length > query.page.limit
        ? { nextPosition: { offset: offset + pageRows.length } }
        : {}),
    };
  }

  /** Fetch one record by primary key, or null if there is none. */
  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    const { rows } = await this.execute(
      buildGet(dialect, this.target(collection), id),
    );
    return rows[0] ? normalizeRow(collection, rows[0]) : null;
  }

  /** Insert a record and return the stored row (via RETURNING). */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    const { rows } = await this.execute(
      buildInsert(dialect, this.target(collection), values),
    );
    if (!rows[0]) {
      throw errors.internal('Insert returned no row');
    }
    return normalizeRow(collection, rows[0]);
  }

  /** Update by primary key; throws notFound if no row matched. */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    const { rows } = await this.execute(
      buildUpdate(dialect, this.target(collection), id, values),
    );
    if (!rows[0]) {
      throw errors.notFound('Record not found');
    }
    return normalizeRow(collection, rows[0]);
  }

  /** Delete by primary key; throws notFound if no row matched. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    const { rows } = await this.execute(
      buildDelete(dialect, this.target(collection), id),
    );
    if (!rows[0]) {
      throw errors.notFound('Record not found');
    }
  }

  /**
   * Create the table for a collection. Used by migration when the
   * administrator asked for missing tables to be created.
   */
  async createCollection(collection: CollectionDefinition): Promise<void> {
    if (this.readOnly) {
      throw errors.readOnly();
    }
    // Re-introspect so we see tables created since connect, both to refuse a
    // name clash and to know which foreign-key targets already exist.
    const current = await this.introspect();
    if (
      current.some(
        (existing) =>
          existing.name === (collection.nativeName ?? collection.name),
      )
    ) {
      throw errors.conflict('A table with this name already exists');
    }
    const all = new Map(current.map((existing) => [existing.name, existing]));
    all.set(collection.name, collection);
    const { statements } = buildCreateTable(dialect, {
      schema: undefined,
      collection,
      all,
      existing: new Set(current.map((c) => c.name)),
    });
    for (const statement of statements) {
      await this.execute(statement);
    }
  }

  /**
   * Nothing to do after a bulk load: AUTOINCREMENT already continues from
   * the highest id.
   */
  async finishBulkLoad(): Promise<void> {}

  /** Close the database. Safe to call twice; errors on close are ignored. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------

  // No schema prefix: a SQLite file is one namespace.
  private target(collection: CollectionDefinition) {
    return { schema: undefined, collection };
  }

  // The live client, or a connection error if connect() has not succeeded.
  private connected(): SqlClient {
    if (!this.client) {
      throw errors.connectionFailed('Adapter is not connected');
    }
    return this.client;
  }

  // Run a database action and translate any failure into a safe error.
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  // Send one compiled statement. Values travel separately from the text.
  private execute(statement: CompiledSql) {
    return this.run(() =>
      this.connected().query(statement.text, statement.values),
    );
  }
}

// Read the paging offset from the cursor position, defaulting to the first
// page. Anything malformed is treated as 0.
function readOffset(position: unknown): number {
  if (
    typeof position === 'object' &&
    position !== null &&
    'offset' in position
  ) {
    const offset = (position as { offset: unknown }).offset;
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) {
      return offset;
    }
  }
  return 0;
}
