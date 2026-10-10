/**
 * The reference adapter: stores records in memory.
 *
 * It exists for three reasons: tests of the gateway need a database, demos
 * need one that needs no setup, and new adapter authors need a small,
 * readable example of the contract. It is not meant for production data.
 */
import {
  PRESETS,
  defineCapabilities,
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
import { compareValues, matches } from './matcher.js';

// One collection's data: rows keyed by stringified primary key, plus the
// next auto-generated id.
interface Table {
  rows: Map<string, RecordData>;
  nextId: number;
}

/** Options for constructing a MemoryAdapter. */
export interface MemoryAdapterOptions {
  /** Collections this database "contains"; returned by introspect(). */
  collections: CollectionDefinition[];
  /**
   * Override capabilities, for example to test how the platform treats a
   * limited database.
   */
  capabilities?: Capabilities;
}

/**
 * In-memory Adapter. Data lives only as long as the instance and is reset by
 * every connect(). Records are copied on the way in and out so callers can
 * never mutate stored rows by accident.
 */
export class MemoryAdapter implements Adapter {
  readonly type = 'memory';
  private readonly definitions: CollectionDefinition[];
  private readonly caps: Capabilities;
  private tables = new Map<string, Table>();
  private connected = false;

  constructor(options: MemoryAdapterOptions) {
    this.definitions = options.collections;
    // Default: the SQL preset without offset pagination (clients page using
    // the returned position).
    this.caps =
      options.capabilities ??
      defineCapabilities({ ...PRESETS.sql, pagination: { offset: false } });
  }

  /** Reset to empty tables, one per collection definition. */
  async connect(_input: ConnectInput): Promise<void> {
    this.tables = new Map(
      this.definitions.map((c) => [c.name, { rows: new Map(), nextId: 1 }]),
    );
    this.connected = true;
  }

  /** The configured (or default) capability set. */
  capabilities(): Capabilities {
    return this.caps;
  }

  /** The collections passed to the constructor; nothing is discovered. */
  async introspect(): Promise<CollectionDefinition[]> {
    return this.definitions;
  }

  /**
   * List records: filter, sort, then slice a page. Sorting happens in memory
   * on every call, which is fine for tests and demos.
   */
  async find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult> {
    const rows = [...this.table(collection).rows.values()].filter((row) =>
      matches(row, query.filter),
    );

    // Always finish with the primary key so the order is stable between pages.
    // It is appended even if the caller already sorted by it (harmless).
    const keyName = primaryKeyOf(collection).name;
    const sorts = [
      ...(query.sort ?? []),
      { field: keyName, dir: 'asc' as const },
    ];
    rows.sort((a, b) => {
      for (const { field, dir } of sorts) {
        const result = compareValues(a[field], b[field]);
        if (result !== 0) {
          return dir === 'asc' ? result : -result;
        }
      }
      return 0;
    });

    // The "position" is how many rows came before this page.
    const start = readOffset(position);
    const page = rows.slice(start, start + query.page.limit);
    const hasMore = start + page.length < rows.length;

    return {
      records: page.map((row) => project(row, query.projection)),
      ...(hasMore ? { nextPosition: { offset: start + page.length } } : {}),
    };
  }

  /** Fetch one record by id (a copy), or null if there is none. */
  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    const row = this.table(collection).rows.get(id);
    return row ? { ...row } : null;
  }

  /**
   * Insert a record. Generated keys take the next counter value; otherwise
   * the caller must supply the key. Unspecified fields are stored as null so
   * every record has every field, like a SQL row.
   */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    const table = this.table(collection);
    const key = primaryKeyOf(collection);

    const record: RecordData = { ...values };
    for (const field of collection.fields) {
      if (!(field.name in record)) {
        record[field.name] = null;
      }
    }

    if (key.generated) {
      record[key.name] = table.nextId++;
    } else if (record[key.name] === null || record[key.name] === undefined) {
      throw errors.validation(`${key.name} is required`);
    }

    const id = String(record[key.name]);
    if (table.rows.has(id)) {
      throw errors.conflict('A record with this id already exists');
    }
    table.rows.set(id, record);
    return { ...record };
  }

  /** Merge `values` into an existing record; throws notFound if absent. */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    const table = this.table(collection);
    const existing = table.rows.get(id);
    if (!existing) {
      throw errors.notFound('Record not found');
    }

    const updated = { ...existing, ...values };
    table.rows.set(id, updated);
    return { ...updated };
  }

  /** Remove a record; throws notFound if there was none. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    if (!this.table(collection).rows.delete(id)) {
      throw errors.notFound('Record not found');
    }
  }

  /** Mark the adapter disconnected. Stored data is kept until connect(). */
  async close(): Promise<void> {
    this.connected = false;
  }

  // The table for a collection; refuses to work before connect() so misuse
  // behaves like a real database that is not reachable.
  private table(collection: CollectionDefinition): Table {
    if (!this.connected) {
      throw errors.connectionFailed('Adapter is not connected');
    }
    const table = this.tables.get(collection.name);
    if (!table) {
      throw errors.notFound('Unknown collection');
    }
    return table;
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

// Keep only the requested fields (all fields when there is no projection).
// Requested names the record lacks are skipped rather than set to undefined.
function project(row: RecordData, fields: string[] | undefined): RecordData {
  if (!fields) {
    return { ...row };
  }
  return Object.fromEntries(
    fields.filter((name) => name in row).map((name) => [name, row[name]]),
  );
}
