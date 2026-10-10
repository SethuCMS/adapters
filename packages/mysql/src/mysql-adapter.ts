/**
 * The MySQL / MariaDB adapter. SQL is built by the shared sql-kit. MySQL has
 * no RETURNING, so a write is followed by a read of the same record.
 */
import {
  PRESETS,
  errors,
  primaryKeyOf,
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
  mysqlDialect,
  normalizeRow,
  type CompiledSql,
  type SqlClient,
  type SqlResult,
} from '@sethucms/adapter-sql-kit';
import { createMysqlClient, type SqlClientFactory } from './client.js';
import { mapMysqlError } from './errors.js';
import { introspectSchema } from './introspect.js';
import { parseSettings } from './settings.js';

// MySQL supports the same capability set as the other SQL databases.
const CAPABILITIES: Capabilities = PRESETS.sql;
// All SQL here comes from sql-kit with this dialect.
const dialect = mysqlDialect;

/** Options for constructing a MysqlAdapter. */
export interface MysqlAdapterOptions {
  /** Replace the real driver, for tests. */
  clientFactory?: SqlClientFactory;
}

/**
 * Adapter for MySQL and MariaDB. Holds one connection pool per connect() and
 * maps every database error to a safe platform error.
 */
export class MysqlAdapter implements Adapter {
  readonly type = 'mysql';
  private client: SqlClient | undefined;
  private readOnly = false;
  private readonly clientFactory: SqlClientFactory;

  constructor(options: MysqlAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? createMysqlClient;
  }

  /** Validate settings, open the pool, and prove it works with SELECT 1. */
  async connect(input: ConnectInput): Promise<void> {
    // Fails early, with a message that never includes secrets.
    parseSettings(input);
    this.readOnly = input.readOnly;
    try {
      this.client = await this.clientFactory(input);
      await this.client.query('SELECT 1');
    } catch (error) {
      // Do not leave a half-open pool behind after a failed connect.
      await this.close();
      throw mapMysqlError(error);
    }
  }

  /** The fixed capability set for SQL databases. */
  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** Discover the connected database's tables as collections. */
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
      buildSelect(dialect, target(collection), query, offset),
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
    // Reject malformed ids up front; see isValidKey for why.
    if (!isValidKey(collection, id)) {
      return null;
    }
    const { rows } = await this.execute(
      buildGet(dialect, target(collection), id),
    );
    return rows[0] ? normalizeRow(collection, rows[0]) : null;
  }

  /**
   * Insert a record and return it. Without RETURNING, the new key is the one
   * the caller supplied or else the driver's generated insertId, and the row
   * is read back so defaults and normalisation apply.
   */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    const result = await this.execute(
      buildInsert(dialect, target(collection), values),
    );
    const key = primaryKeyOf(collection).name;
    const given = values[key];
    const id =
      given !== undefined && given !== null
        ? String(given)
        : result.insertId !== undefined
          ? String(result.insertId)
          : undefined;
    if (id === undefined) {
      throw errors.internal('Insert returned no key');
    }
    const created = await this.get(collection, id);
    if (!created) {
      throw errors.internal('Inserted record could not be read back');
    }
    return created;
  }

  /** Update by primary key; throws notFound if no row matched. */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    if (!isValidKey(collection, id)) {
      throw errors.notFound('Record not found');
    }
    const result = await this.execute(
      buildUpdate(dialect, target(collection), id, values),
    );
    if (!result.affected) {
      throw errors.notFound('Record not found');
    } // rows matched (the driver asks for matched, not changed)
    const updated = await this.get(collection, id);
    if (!updated) {
      throw errors.notFound('Record not found');
    }
    return updated;
  }

  /** Delete by primary key; throws notFound if no row matched. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    if (!isValidKey(collection, id)) {
      throw errors.notFound('Record not found');
    }
    const result = await this.execute(
      buildDelete(dialect, target(collection), id),
    );
    if (!result.affected) {
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
   * Nothing to do after a bulk load: AUTO_INCREMENT continues from the
   * highest id by itself (unlike a Postgres sequence, which needs repair).
   */
  async finishBulkLoad(): Promise<void> {}

  /** Close the pool. Safe to call twice; errors on close are ignored. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
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
      throw mapMysqlError(error);
    }
  }

  // Send one compiled statement. Values travel separately from the text.
  private execute(statement: CompiledSql): Promise<SqlResult> {
    return this.run(() =>
      this.connected().query(statement.text, statement.values),
    );
  }
}

// The connection is already scoped to one database, so no schema prefix is
// needed.
const target = (collection: CollectionDefinition) => ({
  schema: undefined,
  collection,
});

/**
 * Is this id acceptable for the collection's key? MySQL turns "abc" into 0
 * and "1abc" into 1 when it compares text with a number, so a bad id could
 * match a real record. Integer keys must look like integers.
 */
function isValidKey(collection: CollectionDefinition, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  const key = collection.fields.find(
    (field) => field.name === primaryKeyOf(collection).name,
  );
  // Up to 20 digits covers BIGINT; the pattern also blocks any SQL text.
  return key?.type === 'integer' ? /^-?\d{1,20}$/.test(id) : true;
}

// Read the paging offset from the cursor position, defaulting to the first
// page. Anything malformed is treated as 0; the builder re-validates it
// before inlining it into LIMIT/OFFSET.
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
