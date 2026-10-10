/**
 * The PostgreSQL adapter.
 *
 * It turns portable queries into parameterised SQL (see sql.ts), runs them
 * through a SqlClient, and turns rows back into plain records. Safety rules
 * that apply to every database (read-only, validation, signed cursors,
 * timeouts) are enforced by the GuardedAdapter around it.
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
  createPgClient,
  parseSettings,
  type SqlClient,
  type SqlClientFactory,
} from './client.js';
import { isInvalidTextError, mapPostgresError } from './errors.js';
import { introspectSchema } from './introspect.js';
import { normalizeRow } from './rows.js';
import {
  buildDelete,
  buildGet,
  buildInsert,
  buildSelect,
  buildUpdate,
  quoteIdentifier,
  type CompiledSql,
} from './sql.js';
import { buildCreateTable, postgresDialect } from '@sethucms/adapter-sql-kit';

/**
 * PostgreSQL can do everything the platform asks for, except realtime and
 * full-text search (for now).
 */
const CAPABILITIES: Capabilities = PRESETS.sql;

/** Options for constructing a PostgresAdapter. */
export interface PostgresAdapterOptions {
  /** Replace the real driver, for tests. */
  clientFactory?: SqlClientFactory;
}

/**
 * Adapter for PostgreSQL. Holds one connection pool per connect() and maps
 * every database error to a safe platform error.
 */
export class PostgresAdapter implements Adapter {
  readonly type = 'postgres';
  private client: SqlClient | undefined;
  private schema = 'public';
  private readonly clientFactory: SqlClientFactory;
  private readOnly = false;

  constructor(options: PostgresAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? createPgClient;
  }

  /** Validate settings, open the pool, and prove it works with SELECT 1. */
  async connect(input: ConnectInput): Promise<void> {
    // Fails early, with a message that never includes secrets.
    const settings = parseSettings(input);
    this.schema = settings.schema;
    this.readOnly = input.readOnly;
    try {
      this.client = await this.clientFactory(input);
      await this.client.query('SELECT 1');
    } catch (error) {
      // Do not leave a half-open pool behind after a failed connect.
      await this.close();
      throw mapPostgresError(error);
    }
  }

  /** The fixed capability set for SQL databases. */
  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /** Discover tables in the configured schema as collections. */
  async introspect(): Promise<CollectionDefinition[]> {
    return this.run(() => introspectSchema(this.connected(), this.schema));
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
    const statement = buildSelect(this.target(collection), query, offset);
    const { rows } = await this.execute(statement);

    // The query asked for limit+1 rows; the extra one only proves a next page
    // exists and is not returned.
    const pageRows = rows.slice(0, query.page.limit);
    const hasMore = rows.length > query.page.limit;
    return {
      records: pageRows.map((row) => normalizeRow(collection, row)),
      ...(hasMore
        ? { nextPosition: { offset: offset + pageRows.length } }
        : {}),
    };
  }

  /** Fetch one record by primary key, or null if there is none. */
  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    const row = await this.executeById(buildGet(this.target(collection), id));
    return row ? normalizeRow(collection, row) : null;
  }

  /** Insert a record and return the stored row (via RETURNING). */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    const { rows } = await this.execute(
      buildInsert(this.target(collection), values),
    );
    const row = rows[0];
    if (!row) {
      throw errors.internal('Insert returned no row');
    }
    return normalizeRow(collection, row);
  }

  /** Update by primary key; throws notFound if no row matched. */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    const row = await this.executeById(
      buildUpdate(this.target(collection), id, values),
    );
    if (!row) {
      throw errors.notFound('Record not found');
    }
    return normalizeRow(collection, row);
  }

  /** Delete by primary key; throws notFound if no row matched. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    const row = await this.executeById(
      buildDelete(this.target(collection), id),
    );
    if (!row) {
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
    const { statements } = buildCreateTable(postgresDialect, {
      schema: this.schema,
      collection,
      all,
      existing: new Set(current.map((c) => c.name)),
    });
    for (const statement of statements) {
      await this.execute(statement);
    }
  }

  /**
   * After records were copied with their original ids, move the id counter
   * past the highest one. Otherwise the next record created through the CMS
   * would reuse an id and fail.
   */
  async finishBulkLoad(collection: CollectionDefinition): Promise<void> {
    if (this.readOnly) {
      throw errors.readOnly();
    }
    const key = primaryKeyOf(collection).name;
    // Both parts are quoted through the dialect (injection-safe). Identifiers
    // cannot be bound as parameters, so this is the only splice into the text.
    const table = `${quoteIdentifier(this.schema)}.${quoteIdentifier(collection.nativeName ?? collection.name)}`;
    const column = quoteIdentifier(key);
    const { rows } = await this.execute({
      // Looks up the sequence behind the key column; NULL when the key is not
      // serial/identity. The table and column are bound as parameters.
      text: 'SELECT pg_get_serial_sequence($1, $2) AS sequence',
      values: [table, key],
    });
    const sequence = rows[0]?.['sequence'];
    // The key is not generated by the database, so there is no counter.
    if (typeof sequence !== 'string') {
      return;
    } // the key is not generated by the database
    await this.execute({
      // setval(seq, max, is_called): with an empty table use 1 and is_called
      // false so the first generated id is 1, not 2.
      text: `SELECT setval($1, COALESCE(MAX(${column}), 1), MAX(${column}) IS NOT NULL) FROM ${table}`,
      values: [sequence],
    });
  }

  /** Close the pool. Safe to call twice; errors on close are ignored. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------

  // Where this adapter reads and writes: the configured schema.
  private target(collection: CollectionDefinition) {
    return { schema: this.schema, collection };
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
      throw mapPostgresError(error);
    }
  }

  // Send one compiled statement. Values travel separately from the text.
  private execute(statement: CompiledSql) {
    return this.run(() =>
      this.connected().query(statement.text, statement.values),
    );
  }

  /**
   * For statements keyed by id: a value that cannot be a valid key (for
   * example "abc" for an integer key) simply matches nothing.
   */
  private async executeById(
    statement: CompiledSql,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const { rows } = await this.connected().query(
        statement.text,
        statement.values,
      );
      return rows[0];
    } catch (error) {
      if (isInvalidTextError(error)) {
        return undefined;
      }
      throw mapPostgresError(error);
    }
  }
}

// Read the paging offset from the cursor position, defaulting to the first
// page. Anything malformed is treated as 0 and never reaches the SQL text.
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
