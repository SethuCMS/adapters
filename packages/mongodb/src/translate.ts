/**
 * Turning portable queries and records into MongoDB queries and documents.
 *
 * Safety rules:
 *   - field names come only from the collection definition;
 *   - values are never allowed to be objects that could carry query operators
 *     ($where, $regex, ...): filter values are scalars, and JSON values written
 *     to documents may not contain keys starting with "$" or containing ".";
 *   - text matching uses an escaped regular expression, so user text is literal.
 */
import {
  errors,
  primaryKeyOf,
  type CollectionDefinition,
  type FieldDefinition,
  type Filter,
  type Query,
} from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';

/** A raw MongoDB document. */
export type Doc = Record<string, unknown>;

/**
 * Escape regex metacharacters so user text matches literally.
 * `-` is escaped too, in case the text lands inside a character class.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

/** The name a field has in the stored document: the primary key is always `_id`. */
export function storedName(
  collection: CollectionDefinition,
  field: string,
): string {
  return field === primaryKeyOf(collection).name ? '_id' : field;
}

/**
 * Look up a field by name. Rejecting unknown names is what keeps field
 * names in queries limited to the collection definition (no injected paths).
 */
function fieldOf(
  collection: CollectionDefinition,
  name: string,
): FieldDefinition {
  const field = collection.fields.find((candidate) => candidate.name === name);
  if (!field) {
    throw errors.validation('Unknown field');
  }
  return field;
}

/** Reject JSON that MongoDB would treat as operators or paths. */
export function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 20) {
    throw errors.validation('Value is nested too deeply');
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJson(item, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || key.includes('\0')) {
        throw errors.validation('Keys may not start with "$" or contain "."');
      }
      assertSafeJson(child, depth + 1);
    }
  }
}

/** A value from the portable record format, as MongoDB should store or compare it. */
export function toStored(
  field: FieldDefinition,
  value: unknown,
  driver?: { Binary: new (b: Buffer) => unknown },
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (field.type) {
    case 'datetime':
    case 'date':
      return typeof value === 'string' ? new Date(value) : value;
    case 'binary':
      return typeof value === 'string' && driver
        ? new driver.Binary(Buffer.from(value, 'base64'))
        : value;
    case 'json':
    case 'geopoint':
    case 'array':
      assertSafeJson(value);
      return value;
    default:
      return value;
  }
}

/** A stored value, as the portable record format wants it. */
export function fromStored(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return field.type === 'date'
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString();
  }
  if (typeof value === 'object') {
    const typed = value as {
      _bsontype?: string;
      toHexString?: () => string;
      buffer?: Uint8Array;
      value?: () => unknown;
      toString: () => string;
    };
    if (typed._bsontype === 'ObjectId' && typed.toHexString) {
      return typed.toHexString();
    }
    if (typed._bsontype === 'Binary' && typed.buffer) {
      return Buffer.from(typed.buffer).toString('base64');
    }
    if (
      typed._bsontype === 'Long' ||
      typed._bsontype === 'Int32' ||
      typed._bsontype === 'Double'
    ) {
      return Number(typed.toString());
    }
    if (typed._bsontype === 'Decimal128') {
      return Number(typed.toString());
    }
  }
  if (field.type === 'binary' && value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  return value;
}

/**
 * Turn a stored document into a portable record, renaming `_id` back to
 * the collection's primary key name and honouring a projection.
 */
export function toRecord(
  collection: CollectionDefinition,
  doc: Doc,
  projection?: string[],
): RecordData {
  const record: RecordData = {};
  for (const field of collection.fields) {
    if (projection && !projection.includes(field.name)) {
      continue;
    }
    record[field.name] = fromStored(
      field,
      doc[storedName(collection, field.name)],
    );
  }
  return record;
}

/**
 * Turn portable values into a document for writing, renaming the primary
 * key to `_id` and validating each value against its field.
 */
export function toDocument(
  collection: CollectionDefinition,
  values: RecordData,
  driver?: { Binary: new (b: Buffer) => unknown },
): Doc {
  const doc: Doc = {};
  for (const [name, value] of Object.entries(values)) {
    doc[storedName(collection, name)] = toStored(
      fieldOf(collection, name),
      value,
      driver,
    );
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Filter values must be scalars: an object value could smuggle in an
 * operator such as `{ $ne: null }` or `{ $where: ... }`.
 */
function scalar(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    throw errors.validation('Filter values must be plain values');
  }
  return value;
}

/**
 * Compile a portable {@link Filter} tree to a MongoDB query document.
 * Field names are resolved through the definition and values pass through
 * {@link scalar}, so the output never contains caller-controlled operators.
 */
export function compileFilter(
  collection: CollectionDefinition,
  filter: Filter,
): Doc {
  if ('and' in filter) {
    return {
      $and: filter.and.map((child) => compileFilter(collection, child)),
    };
  }
  if ('or' in filter) {
    return { $or: filter.or.map((child) => compileFilter(collection, child)) };
  }
  if ('not' in filter) {
    return { $nor: [compileFilter(collection, filter.not)] };
  }

  const field = fieldOf(collection, filter.field);
  const name = storedName(collection, filter.field);
  // Every filter value is checked as a scalar, then converted like a
  // stored value (e.g. ISO string -> Date) so comparisons are type-correct.
  const convert = (raw: unknown) => toStored(field, scalar(raw));
  const value = filter.value;

  switch (filter.op) {
    case 'eq':
      return { [name]: convert(value) }; // null also matches a missing field
    case 'ne':
      return { [name]: { $ne: convert(value) } }; // and $ne: null excludes missing fields
    case 'lt':
      return { [name]: { $lt: convert(value) } };
    case 'lte':
      return { [name]: { $lte: convert(value) } };
    case 'gt':
      return { [name]: { $gt: convert(value) } };
    case 'gte':
      return { [name]: { $gte: convert(value) } };
    // Each element is converted individually; `$in` itself is fixed by us.
    case 'in':
      return { [name]: { $in: (value as unknown[]).map(convert) } };
    case 'nin':
      return { [name]: { $nin: (value as unknown[]).map(convert) } };
    // Case-insensitive substring via an escaped regex (user text is
    // literal). Array fields use native element matching instead.
    case 'contains':
      if (field.type === 'array') {
        return { [name]: convert(value) };
      } // array element match
      return { [name]: { $regex: escapeRegex(String(value)), $options: 'i' } };
    case 'startsWith':
      return {
        [name]: { $regex: `^${escapeRegex(String(value))}`, $options: 'i' },
      };
    // Mongo cannot tell missing from null in these filters, so both are
    // treated as "absent".
    case 'exists':
      return value === false ? { [name]: null } : { [name]: { $ne: null } };
  }
}

/** The pieces of a `find()` call, compiled from a portable query. */
export interface FindSpec {
  filter: Doc;
  sort: Record<string, 1 | -1>;
  projection: Record<string, 1> | undefined;
}

/**
 * Compile a portable {@link Query} to filter/sort/projection.
 * The primary key is appended to the sort as a tie-breaker so offset
 * paging is stable and deterministic.
 */
export function compileFind(
  collection: CollectionDefinition,
  query: Query,
): FindSpec {
  const key = primaryKeyOf(collection).name;
  const sorts = [...(query.sort ?? [])];
  if (!sorts.some((sort) => sort.field === key)) {
    sorts.push({ field: key, dir: 'asc' });
  }
  const sort: Record<string, 1 | -1> = {};
  for (const item of sorts) {
    fieldOf(collection, item.field);
    sort[storedName(collection, item.field)] = item.dir === 'asc' ? 1 : -1;
  }
  let projection: Record<string, 1> | undefined;
  if (query.projection) {
    projection = {};
    for (const name of query.projection) {
      fieldOf(collection, name);
      projection[storedName(collection, name)] = 1;
    }
  }
  return {
    filter: query.filter ? compileFilter(collection, query.filter) : {},
    sort,
    projection,
  };
}
