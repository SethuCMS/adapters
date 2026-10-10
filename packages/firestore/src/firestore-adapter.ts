/**
 * The Firestore (Firebase) adapter.
 *
 * Firestore has no schema, no auto-increment and no substring search, so:
 *   - the document id is the primary key (called `id` when the model is guessed);
 *   - an integer key marked "generated" is numbered from a counter document,
 *     updated in the same transaction that creates the record;
 *   - the content model comes from the definition saved when SethuCMS created
 *     the collection, then from declared definitions, then from sample documents;
 *   - queries Firestore cannot run are refused, not approximated.
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
  createFirestoreClient,
  type FirestoreClientFactory,
  type FirestoreHandle,
} from './client.js';
import { mapFirestoreError } from './errors.js';
import { inferCollection } from './infer.js';
import { parseSettings, type FirestoreSettings } from './settings.js';
import { needsScan, matchesFilter, sortRecords } from './scan.js';
import {
  assertValidDocumentId,
  compileFind,
  toDocument,
  toRecord,
  type Doc,
} from './translate.js';

// Fixed capability set advertised to the platform for this backend.
const CAPABILITIES: Capabilities = PRESETS.firestore;

/** Internal collections. They never appear as content. */
// Underscore-prefixed bookkeeping collections, hidden from introspection.
const COUNTERS = '_sethucms_counters';
const SCHEMAS = '_sethucms_schemas';

/** Options for {@link FirestoreAdapter}. */
export interface FirestoreAdapterOptions {
  /** Replace the real driver, for tests. */
  clientFactory?: FirestoreClientFactory;
}

/** Adapter implementation for Firestore (SDK `Adapter` contract). */
export class FirestoreAdapter implements Adapter {
  readonly type = 'firestore';
  private handle: FirestoreHandle | undefined;
  private settings: FirestoreSettings | undefined;
  private readOnly = false;
  private readonly clientFactory: FirestoreClientFactory;

  constructor(options: FirestoreAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? createFirestoreClient;
  }

  /**
   * Validate settings, open the client, and probe with a 1-document read.
   * On failure the client is closed so nothing leaks.
   */
  async connect(input: ConnectInput): Promise<void> {
    this.settings = parseSettings(input); // fails early, with a message that never includes secrets
    this.readOnly = input.readOnly;
    try {
      this.handle = await this.clientFactory(input);
      await this.limit(this.handle.db.collection(SCHEMAS).limit(1).get());
    } catch (error) {
      await this.close();
      throw mapFirestoreError(error);
    }
  }

  capabilities(): Capabilities {
    return CAPABILITIES;
  }

  /**
   * Discover collections. Precedence: declared definitions, then definitions
   * saved at creation time, then inference from a document sample.
   */
  async introspect(): Promise<CollectionDefinition[]> {
    return this.run(async () => {
      const { db } = this.connected();
      const settings = this.settings!;

      const live = (
        (await this.limit(db.listCollections())) as Array<{ id: string }>
      )
        .map((entry) => entry.id)
        .filter((name) => !name.startsWith('_sethucms_'));

      const known = new Map<string, CollectionDefinition>();
      const saved = (await this.limit(db.collection(SCHEMAS).get())) as {
        docs: Array<{ id: string; data(): Doc }>;
      };
      for (const doc of saved.docs) {
        const raw = doc.data()['definition'];
        const definition = tryDefine(
          typeof raw === 'string' ? safeParse(raw) : raw,
        );
        if (definition) {
          known.set(doc.id, definition);
        }
      }
      for (const raw of settings.declared) {
        const definition = tryDefine(raw);
        if (definition) {
          known.set(definition.name, definition);
        }
      }

      const collections = new Map<string, CollectionDefinition>(known);
      for (const name of live) {
        if (collections.has(name)) {
          continue;
        }
        const sample = (await this.limit(
          db.collection(name).limit(settings.sampleSize).get(),
        )) as { docs: Array<{ data(): Doc }> };
        const inferred = inferCollection(
          name,
          sample.docs.map((doc) => doc.data()),
        );
        if (inferred) {
          collections.set(name, inferred);
        }
      }
      return [...collections.values()];
    });
  }

  /**
   * Offset-paged read. Reads `limit + 1` documents to learn if another page
   * exists without a count query. Text "contains" is routed to a scan.
   */
  async find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult> {
    const offset = readOffset(position);
    const handle = this.connected();
    if (needsScan(collection, query.filter)) {
      return this.scan(collection, query, offset);
    }
    const spec = compileFind(collection, query, filterApi(handle));
    return this.run(async () => {
      let q = this.collectionOf(collection);
      if (spec.filter) {
        q = q.where(spec.filter);
      }
      for (const [field, dir] of spec.orderBy) {
        q = q.orderBy(field, dir);
      }
      if (spec.select) {
        q = q.select(...spec.select);
      }
      q = q.offset(offset).limit(query.page.limit + 1);
      const snapshot = (await this.limit(q.get())) as {
        docs: Array<{ id: string; data(): Doc }>;
      };
      const page = snapshot.docs.slice(0, query.page.limit);
      return {
        records: page.map((doc) =>
          toRecord(collection, doc.id, doc.data(), query.projection),
        ),
        ...(snapshot.docs.length > query.page.limit
          ? { nextPosition: { offset: offset + page.length } }
          : {}),
      };
    });
  }

  /** Text search: read the collection (up to a cap) and filter here. Exact, but it reads every document. */
  private async scan(
    collection: CollectionDefinition,
    query: Query,
    offset: number,
  ): Promise<FindResult> {
    const cap = this.settings!.maxScanDocuments;
    return this.run(async () => {
      const snapshot = (await this.limit(
        this.collectionOf(collection)
          .limit(cap + 1)
          .get(),
      )) as { docs: Array<{ id: string; data(): Doc }> };
      // Refuse instead of returning a partial, wrong answer when the
      // collection is bigger than the scan cap.
      if (snapshot.docs.length > cap) {
        throw errors.unsupported(
          `Searching inside text in Firestore reads every document, and this collection has more than ${cap}. Use "startsWith" or an exact match instead`,
        );
      }
      const all = snapshot.docs.map((doc) =>
        toRecord(collection, doc.id, doc.data()),
      );
      const matching = sortRecords(
        collection,
        query,
        all.filter((record) => matchesFilter(query.filter!, record)),
      );
      const page = matching.slice(offset, offset + query.page.limit);
      const project = (record: RecordData) =>
        query.projection
          ? Object.fromEntries(
              Object.entries(record).filter(([name]) =>
                query.projection!.includes(name),
              ),
            )
          : record;
      return {
        records: page.map(project),
        ...(matching.length > offset + page.length
          ? { nextPosition: { offset: offset + page.length } }
          : {}),
      };
    });
  }

  /** Fetch one record by id; invalid ids simply read as absent. */
  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    if (!isUsableId(id)) {
      return null;
    }
    return this.run(async () => {
      const snapshot = (await this.limit(
        this.collectionOf(collection).doc(id).get(),
      )) as { exists: boolean; id: string; data(): Doc };
      return snapshot.exists
        ? toRecord(collection, snapshot.id, snapshot.data())
        : null;
    });
  }

  /**
   * Insert a record. Missing fields are stored as null so "is null" filters
   * find them. Integer keys are numbered from a counter document inside one
   * transaction (Firestore has no auto-increment); string keys use the given
   * id or an auto id.
   */
  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    this.assertWritable();
    return this.run(async () => {
      const key = primaryKeyOf(collection);
      const data = toDocument(collection, values);
      // Store every declared field, as null when absent, so "is null" filters find it.
      for (const field of collection.fields) {
        if (!field.primaryKey && !(field.name in data)) {
          data[field.name] = null;
        }
      }
      const given = values[key.name];
      const coll = this.collectionOf(collection);

      if (key.type === 'integer') {
        if (
          given !== undefined &&
          given !== null &&
          !Number.isSafeInteger(given)
        ) {
          throw errors.validation('The id must be a whole number');
        }
        const { db } = this.connected();
        const counterRef = db.collection(COUNTERS).doc(collection.name);
        const id = await this.limit(
          db.runTransaction(async (tx: any) => {
            const current = (await tx.get(counterRef)) as {
              exists: boolean;
              data(): Doc;
            };
            const seq =
              current.exists && typeof current.data()['seq'] === 'number'
                ? (current.data()['seq'] as number)
                : 0;
            const next =
              given !== undefined && given !== null
                ? (given as number)
                : seq + 1;
            tx.create(coll.doc(String(next)), data); // fails if the id is taken
            tx.set(counterRef, { seq: Math.max(seq, next) }); // the counter always stays past the highest id
            return next;
          }),
        );
        return toRecord(collection, String(id), data);
      }

      let ref;
      if (given !== undefined && given !== null) {
        assertValidDocumentId(String(given));
        ref = coll.doc(String(given));
      } else if (key.generated) {
        ref = coll.doc();
      } else {
        throw errors.validation('A value for the primary key is required');
      }
      await this.limit(ref.create(data));
      return toRecord(collection, ref.id, data);
    });
  }

  /**
   * Partial update. `update()` fails if the document does not exist, which
   * is what turns a missing id into NOT_FOUND.
   */
  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    this.assertWritable();
    if (!isUsableId(id)) {
      throw errors.notFound('Record not found');
    }
    const data = toDocument(collection, values);
    if (Object.keys(data).length === 0) {
      throw errors.validation('Nothing to update');
    }
    return this.run(async () => {
      const ref = this.collectionOf(collection).doc(id);
      await this.limit(ref.update(data)); // fails with NOT_FOUND when the document does not exist
      const snapshot = (await this.limit(ref.get())) as {
        exists: boolean;
        id: string;
        data(): Doc;
      };
      if (!snapshot.exists) {
        throw errors.notFound('Record not found');
      }
      return toRecord(collection, snapshot.id, snapshot.data());
    });
  }

  /** Delete by id; `exists: true` makes a missing document an error. */
  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    this.assertWritable();
    if (!isUsableId(id)) {
      throw errors.notFound('Record not found');
    }
    await this.run(async () => {
      await this.limit(
        this.collectionOf(collection).doc(id).delete({ exists: true }),
      );
    });
  }

  /** Firestore collections appear with their first document, so this only saves the definition (types survive that way). */
  async createCollection(collection: CollectionDefinition): Promise<void> {
    this.assertWritable();
    const existing = await this.introspect();
    if (existing.some((candidate) => candidate.name === collection.name)) {
      throw errors.conflict('A collection with this name already exists');
    }
    await this.run(async () => {
      await this.limit(
        this.connected()
          .db.collection(SCHEMAS)
          .doc(collection.name)
          .set({ definition: JSON.stringify(collection) }),
      );
    });
  }

  // Integer ids raise the counter as they are created, so there is nothing to repair afterwards.
  async finishBulkLoad(): Promise<void> {}

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------

  // Return the live handle or fail with a clear "not connected" error.
  private connected(): FirestoreHandle {
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

  // Single funnel for driver calls so failures are mapped to platform
  // errors and raw driver messages never reach callers.
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  /** Give a call a time limit, so a stuck connection cannot hold a request forever. */
  private limit<T>(promise: Promise<T>): Promise<T> {
    const ms = this.settings?.statementTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(errors.timeout('The database took too long to respond')),
        ms,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

// Adapt the driver's static `Filter` class to the {@link DriverFilter}
// shape used by the translator.
function filterApi(handle: FirestoreHandle) {
  const F = handle.Filter;
  return {
    where: (field: string, op: string, value: unknown) =>
      F.where(field, op, value),
    and: (...filters: unknown[]) => F.and(...filters),
    or: (...filters: unknown[]) => F.or(...filters),
  };
}

// Invalid ids (slashes, "..", `__x__`) would address other documents or
// throw in the driver, so they are treated as "no such record".
function isUsableId(id: string): boolean {
  try {
    assertValidDocumentId(id);
    return true;
  } catch {
    return false;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Saved/declared definitions are untrusted data: skip invalid ones.
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
