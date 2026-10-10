/**
 * The MongoDB adapter.
 *
 * MongoDB has no schema and no auto-increment, so:
 *   - the content model is read from definitions saved when SethuCMS created
 *     the collection, then from definitions the administrator declared, then
 *     guessed from sample documents (see infer.ts);
 *   - the primary key is stored as `_id`; whatever name the collection
 *     definition gives it is translated on the way in and out;
 *   - an integer key marked "generated" is numbered from a counter collection,
 *     and a string key is a new ObjectId (returned as text).
 */
import {
  PRESETS,
  defineCollection,
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
  createMongoClient,
  type MongoClientFactory,
  type MongoHandle,
} from './client.js';
import { mapMongoError } from './errors.js';
import { inferCollection } from './infer.js';
import { parseSettings, type MongoSettings } from './settings.js';
import { compileFind, toDocument, toRecord, type Doc } from './translate.js';

// Fixed capability set advertised to the platform for this backend.
const CAPABILITIES: Capabilities = PRESETS.mongodb;

/** Internal collections. They never appear as content. */
// Underscore-prefixed bookkeeping collections, hidden from introspection.
const COUNTERS = '_sethucms_counters';
const SCHEMAS = '_sethucms_schemas';

/** Options for {@link MongoAdapter}. */
export interface MongoAdapterOptions {
  /** Replace the real driver, for tests. */
  clientFactory?: MongoClientFactory;
}

/** Adapter implementation for MongoDB (SDK `Adapter` contract). */
export class MongoAdapter implements Adapter {
  readonly type = 'mongodb';
  private handle: MongoHandle | undefined;
  private settings: MongoSettings | undefined;
  private readOnly = false;
  private readonly clientFactory: MongoClientFactory;

  constructor(options: MongoAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? createMongoClient;
  }

  /**
   * Validate settings, open the client and ping to prove the connection.
   * On failure the half-open client is closed so nothing leaks.
   */
  async connect(input: ConnectInput): Promise<void> {
    this.settings = parseSettings(input); // fails early, with a message that never includes secrets
    this.readOnly = input.readOnly;
    try {
      this.handle = await this.clientFactory(input);
      await this.handle.db.command({ ping: 1 });
    } catch (error) {
      await this.close();
      throw mapMongoError(error);
    }
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /**
   * Discover collections. Precedence: admin-declared definitions, then
   * definitions saved at creation time, then inference from a document
   * sample. Internal and `system.*` collections are skipped.
   */
  async introspect(): Promise<CollectionDefinition[]> {
    return this.run(async () => {
      const { db } = this.connected();
      const settings = this.settings!;

      const names = (
        (await db
          .listCollections({ type: 'collection' }, { nameOnly: true })
          .toArray()) as Array<{ name: string }>
      )
        .map((entry) => entry.name)
        .filter(
          (name) =>
            !name.startsWith('system.') &&
            name !== COUNTERS &&
            name !== SCHEMAS,
        );

      const saved = new Map<string, CollectionDefinition>();
      for (const doc of (await db
        .collection(SCHEMAS)
        .find({})
        .toArray()) as Array<{ _id: string; definition: unknown }>) {
        const definition = tryDefine(doc.definition);
        if (definition) {
          saved.set(doc._id, definition);
        }
      }
      const declared = new Map<string, CollectionDefinition>();
      for (const raw of settings.declared) {
        const definition = tryDefine(raw);
        if (definition) {
          declared.set(definition.name, definition);
        }
      }

      const collections: CollectionDefinition[] = [];
      for (const name of names) {
        const known = declared.get(name) ?? saved.get(name);
        if (known) {
          collections.push(known);
          continue;
        }
        const sample = (await db
          .collection(name)
          .find({})
          .limit(settings.sampleSize)
          .maxTimeMS(settings.statementTimeoutMs)
          .toArray()) as Doc[];
        const inferred = inferCollection(name, sample);
        if (inferred) {
          collections.push(inferred);
        }
      }
      return collections;
    });
  }

  /**
   * Offset-paged read. Fetches `limit + 1` documents: the extra one only
   * signals that another page exists, without a separate count query.
   */
  async find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult> {
    const offset = readOffset(position);
    const spec = compileFind(collection, query);
    const docs = await this.run(async () => {
      let cursor = this.collectionOf(collection)
        .find(spec.filter)
        .sort(spec.sort)
        .skip(offset)
        .limit(query.page.limit + 1)
        .maxTimeMS(this.settings!.statementTimeoutMs);
      if (spec.projection) {
        cursor = cursor.project(spec.projection);
      }
      return (await cursor.toArray()) as Doc[];
    });
    const page = docs.slice(0, query.page.limit);
    return {
      records: page.map((doc) => toRecord(collection, doc, query.projection)),
      ...(docs.length > query.page.limit
        ? { nextPosition: { offset: offset + page.length } }
        : {}),
    };
  }

  /** Fetch one record by id, or `null` when absent. */
  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    const doc = await this.run(async () =>
      this.collectionOf(collection).findOne(this.idFilter(collection, id), {
        maxTimeMS: this.settings!.statementTimeoutMs,
      }),
    );
    return doc ? toRecord(collection, doc as Doc) : null;
  }

  /**
   * Insert a record. Nulls are dropped because Mongo treats null and
   * missing alike. A missing key is generated: integers from the counter
   * collection (Mongo has no auto-increment), strings as a new ObjectId.
   */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    this.assertWritable();
    return this.run(async () => {
      const key = primaryKeyOf(collection);
      const doc = toDocument(collection, values, this.connected().driver);
      for (const [name, value] of Object.entries(doc)) {
        if (value === null) {
          delete doc[name];
        }
      } // missing and null read the same

      if (doc['_id'] === undefined) {
        if (key.type === 'integer') {
          doc['_id'] = await this.nextNumber(collection);
        } else if (key.type === 'string' && key.generated) {
          doc['_id'] = new (this.connected().driver.ObjectId)();
        } else {
          throw errors.validation('A value for the primary key is required');
        }
      }
      await this.collectionOf(collection).insertOne(doc);
      return toRecord(collection, doc);
    });
  }

  /**
   * Partial update with `$set`. `_id` is stripped so the key can never be
   * changed, and `$set` is built from validated values only.
   */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    this.assertWritable();
    if (Object.keys(values).length === 0) {
      throw errors.validation('Nothing to update');
    }
    return this.run(async () => {
      const doc = toDocument(collection, values, this.connected().driver);
      delete doc['_id'];
      const updated = await this.collectionOf(collection).findOneAndUpdate(
        this.idFilter(collection, id),
        { $set: doc },
        {
          returnDocument: 'after',
          maxTimeMS: this.settings!.statementTimeoutMs,
        },
      );
      if (!updated) {
        throw errors.notFound('Record not found');
      }
      return toRecord(collection, updated as Doc);
    });
  }

  /** Delete by id; a miss is reported as not-found. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    this.assertWritable();
    await this.run(async () => {
      const result = await this.collectionOf(collection).deleteOne(
        this.idFilter(collection, id),
      );
      if (!result.deletedCount) {
        throw errors.notFound('Record not found');
      }
    });
  }

  /** Create a collection and remember its definition, so types survive (MongoDB cannot store them). */
  async createCollection(collection: CollectionDefinition): Promise<void> {
    this.assertWritable();
    await this.run(async () => {
      const { db } = this.connected();
      const name = collection.nativeName ?? collection.name;
      const existing = (await db
        .listCollections({ name }, { nameOnly: true })
        .toArray()) as unknown[];
      if (existing.length > 0) {
        throw errors.conflict('A collection with this name already exists');
      }
      await db.createCollection(name);
      await db.collection(SCHEMAS).replaceOne(
        { _id: collection.name },
        {
          _id: collection.name,
          definition: JSON.parse(JSON.stringify(collection)),
        },
        { upsert: true },
      );
    });
  }

  /** After records were copied with their original ids, move the counter past the highest one. */
  async finishBulkLoad(collection: CollectionDefinition): Promise<void> {
    this.assertWritable();
    if (primaryKeyOf(collection).type !== 'integer') {
      return;
    }
    await this.run(async () => {
      const top = (await this.collectionOf(collection)
        .find({})
        .sort({ _id: -1 })
        .limit(1)
        .toArray()) as Doc[];
      const max = top[0]?.['_id'];
      if (typeof max !== 'number') {
        return;
      }
      await this.connected()
        .db.collection(COUNTERS)
        .updateOne(
          { _id: collection.name },
          { $max: { seq: max } },
          { upsert: true },
        );
    });
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------

  // Return the live handle or fail with a clear "not connected" error.
  private connected(): MongoHandle {
    if (!this.handle) {
      throw errors.connectionFailed('Adapter is not connected');
    }
    return this.handle;
  }

  private collectionOf(collection: CollectionDefinition) {
    return this.connected().db.collection(
      collection.nativeName ?? collection.name,
    );
  }

  // Guard every write path: connections can be opened read-only.
  private assertWritable(): void {
    if (this.readOnly) {
      throw errors.readOnly();
    }
  }

  // Single funnel for driver calls so every failure is mapped to a
  // platform error and raw driver messages never reach callers.
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapMongoError(error);
    }
  }

  /**
   * The next integer id. The counter is raised past any id that already exists,
   * because documents may have been added with explicit ids.
   */
  private async nextNumber(collection: CollectionDefinition): Promise<number> {
    const { db } = this.connected();
    const counters = db.collection(COUNTERS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // `$inc` with upsert is atomic, so concurrent creates get distinct
      // numbers without a transaction.
      const counter = await counters.findOneAndUpdate(
        { _id: collection.name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
      const seq = (counter as { seq?: number } | null)?.seq;
      if (typeof seq !== 'number') {
        throw errors.internal('Could not number the record');
      }
      // Guard against collisions with ids inserted explicitly; if taken, the
      // counter is advanced past the current max and we retry.
      const taken = await this.collectionOf(collection).findOne(
        { _id: seq },
        { projection: { _id: 1 } },
      );
      if (!taken) {
        return seq;
      }
      const top = (await this.collectionOf(collection)
        .find({})
        .sort({ _id: -1 })
        .limit(1)
        .toArray()) as Doc[];
      const max = top[0]?.['_id'];
      if (typeof max === 'number') {
        await counters.updateOne(
          { _id: collection.name },
          { $max: { seq: max } },
        );
      }
    }
    throw errors.internal('Could not number the record');
  }

  /** `_id` filter. Text ids that look like an ObjectId match either the ObjectId or the text. */
  private idFilter(collection: CollectionDefinition, id: string): Doc {
    const key = primaryKeyOf(collection);
    if (key.type === 'integer') {
      // Non-numeric ids match nothing (empty $in) instead of throwing, and
      // the digit cap keeps the value inside safe-integer range.
      if (!/^-?\d{1,15}$/.test(id)) {
        return { _id: { $in: [] } };
      } // matches nothing
      return { _id: Number(id) };
    }
    // Rows may have been stored either as ObjectId or as hex text, so
    // match both. `String(id)` below keeps ids as plain strings, never
    // objects, which prevents operator injection through the id.
    if (/^[0-9a-f]{24}$/i.test(id)) {
      return { _id: { $in: [new (this.connected().driver.ObjectId)(id), id] } };
    }
    return { _id: String(id) };
  }
}

// Saved/declared definitions are untrusted data: ignore ones that fail
// validation instead of breaking introspection.
function tryDefine(raw: unknown): CollectionDefinition | undefined {
  try {
    return defineCollection(raw as never);
  } catch {
    return undefined;
  }
}

// Paging position is opaque to callers; anything malformed means "start".
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
