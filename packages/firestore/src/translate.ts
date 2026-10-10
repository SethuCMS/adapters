/**
 * Turning portable queries and records into Firestore queries and documents.
 *
 * Firestore cannot do everything the portable query language can. Anything it
 * cannot do is refused with CAPABILITY_UNSUPPORTED instead of being approximated
 * (for example "contains" on text: Firestore has no substring search).
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

export type Doc = Record<string, unknown>;

/** Firestore's name for the document id in queries. */
export const DOC_ID = '__name__';

const MAX_IN = 30;
const MAX_NOT_IN = 10;

export function storedName(
  collection: CollectionDefinition,
  field: string,
): string {
  return field === primaryKeyOf(collection).name ? DOC_ID : field;
}

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

/** Firestore document ids: not empty, no slash, not "." or "..", not __x__, at most 1500 bytes. */
export function assertValidDocumentId(id: string): void {
  if (
    id.length === 0 ||
    Buffer.byteLength(id) > 1500 ||
    id.includes('/') ||
    id === '.' ||
    id === '..' ||
    /^__.*__$/.test(id)
  ) {
    throw errors.validation(
      'This id cannot be used as a Firestore document id',
    );
  }
}

/** Reject nested arrays (Firestore cannot store them) and keys Firestore treats specially. */
export function assertStorable(value: unknown, depth = 0): void {
  if (depth > 20) {
    throw errors.validation('Value is nested too deeply');
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) {
        throw errors.validation(
          'Firestore cannot store an array inside an array',
        );
      }
      assertStorable(item, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.length === 0 || /^__.*__$/.test(key) || key.includes('\0')) {
        throw errors.validation('This key cannot be stored in Firestore');
      }
      assertStorable(child, depth + 1);
    }
  }
}

export function toStored(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (field.type) {
    case 'datetime':
      return typeof value === 'string' ? new Date(value) : value;
    case 'binary':
      return typeof value === 'string' ? Buffer.from(value, 'base64') : value;
    case 'json':
    case 'geopoint':
    case 'array':
      assertStorable(value);
      return value;
    case 'integer':
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw errors.validation('Integer is too large for Firestore');
      }
      return value;
    default:
      return value; // 'date' stays "YYYY-MM-DD" text, which sorts and compares correctly
  }
}

export function fromStored(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    const typed = value as {
      toDate?: () => Date;
      path?: string;
      constructor?: { name?: string };
    };
    if (typeof typed.toDate === 'function') {
      return typed.toDate().toISOString();
    } // Timestamp
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64');
    } // bytes
    if (typeof typed.path === 'string' && field.type === 'string') {
      return typed.path;
    } // document reference
  }
  return value;
}

/** A stored document, as a portable record. The document id fills the primary key. */
export function toRecord(
  collection: CollectionDefinition,
  id: string,
  data: Doc,
  projection?: string[],
): RecordData {
  const key = primaryKeyOf(collection);
  const record: RecordData = {};
  for (const field of collection.fields) {
    if (projection && !projection.includes(field.name)) {
      continue;
    }
    if (field.name === key.name) {
      record[field.name] =
        key.type === 'integer' && /^-?\d{1,15}$/.test(id) ? Number(id) : id;
    } else {
      record[field.name] = fromStored(field, data[field.name]);
    }
  }
  return record;
}

export function toDocument(
  collection: CollectionDefinition,
  values: RecordData,
): Doc {
  const key = primaryKeyOf(collection).name;
  const doc: Doc = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === key) {
      continue;
    } // the key is the document id, not a field
    doc[name] = toStored(fieldOf(collection, name), value);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface DriverFilter {
  where(field: string, op: string, value: unknown): unknown;
  and(...filters: unknown[]): unknown;
  or(...filters: unknown[]): unknown;
}

function scalar(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    throw errors.validation('Filter values must be plain values');
  }
  return value;
}

/** NOT, pushed down to the comparisons (De Morgan), because Firestore has no general NOT. */
export function negate(filter: Filter): Filter {
  if ('and' in filter) {
    return { or: filter.and.map(negate) };
  }
  if ('or' in filter) {
    return { and: filter.or.map(negate) };
  }
  if ('not' in filter) {
    return filter.not;
  }
  const flip: Record<string, string> = {
    eq: 'ne',
    ne: 'eq',
    lt: 'gte',
    gte: 'lt',
    gt: 'lte',
    lte: 'gt',
    in: 'nin',
    nin: 'in',
  };
  if (filter.op === 'exists') {
    return { ...filter, value: filter.value === false };
  }
  const op = flip[filter.op];
  if (!op) {
    throw errors.unsupported(`Firestore cannot negate a "${filter.op}" filter`);
  }
  return { ...filter, op: op as never };
}

export function compileFilter(
  collection: CollectionDefinition,
  filter: Filter,
  F: DriverFilter,
): unknown {
  if ('and' in filter) {
    return F.and(
      ...filter.and.map((child) => compileFilter(collection, child, F)),
    );
  }
  if ('or' in filter) {
    return F.or(
      ...filter.or.map((child) => compileFilter(collection, child, F)),
    );
  }
  if ('not' in filter) {
    return compileFilter(collection, negate(filter.not), F);
  }

  const field = fieldOf(collection, filter.field);
  const name = storedName(collection, filter.field);
  const convert = (raw: unknown) =>
    name === DOC_ID ? String(scalar(raw)) : toStored(field, scalar(raw));
  const value = filter.value;

  switch (filter.op) {
    case 'eq':
      return F.where(name, '==', convert(value));
    case 'ne':
      // Firestore's "!=" skips documents where the field is null; "null or not equal" needs an OR.
      return value === null
        ? F.where(name, '!=', null)
        : F.or(F.where(name, '!=', convert(value)), F.where(name, '==', null));
    case 'lt':
      return F.where(name, '<', convert(value));
    case 'lte':
      return F.where(name, '<=', convert(value));
    case 'gt':
      return F.where(name, '>', convert(value));
    case 'gte':
      return F.where(name, '>=', convert(value));
    case 'in':
    case 'nin': {
      const list = value as unknown[];
      const concrete = list.filter((item) => item !== null).map(convert);
      const hasNull = list.includes(null);
      const max = filter.op === 'in' ? MAX_IN : MAX_NOT_IN;
      if (concrete.length > max) {
        throw errors.unsupported(
          `Firestore allows at most ${max} values in "${filter.op}"`,
        );
      }
      if (filter.op === 'in') {
        if (concrete.length === 0) {
          return F.where(name, '==', null);
        }
        return hasNull
          ? F.or(F.where(name, 'in', concrete), F.where(name, '==', null))
          : F.where(name, 'in', concrete);
      }
      if (concrete.length === 0) {
        return F.where(name, '!=', null);
      }
      return hasNull
        ? F.and(F.where(name, 'not-in', concrete), F.where(name, '!=', null))
        : F.or(F.where(name, 'not-in', concrete), F.where(name, '==', null));
    }
    case 'contains':
      if (field.type === 'array') {
        return F.where(name, 'array-contains', convert(value));
      }
      throw errors.unsupported(
        'Firestore cannot search inside text. Use "startsWith", or an exact match',
      );
    case 'startsWith': {
      const prefix = String(value);
      return F.and(
        F.where(name, '>=', prefix),
        F.where(name, '<', `${prefix}`),
      ); // case-sensitive range scan
    }
    case 'exists':
      return value === false
        ? F.where(name, '==', null)
        : F.where(name, '!=', null);
  }
}

export interface FindSpec {
  filter: unknown | undefined;
  orderBy: Array<[string, 'asc' | 'desc']>;
  select: string[] | undefined;
}

export function compileFind(
  collection: CollectionDefinition,
  query: Query,
  F: DriverFilter,
): FindSpec {
  const key = primaryKeyOf(collection).name;
  const sorts = [...(query.sort ?? [])];
  if (!sorts.some((sort) => sort.field === key)) {
    sorts.push({ field: key, dir: 'asc' });
  }
  const orderBy = sorts.map((sort): [string, 'asc' | 'desc'] => {
    fieldOf(collection, sort.field);
    return [storedName(collection, sort.field), sort.dir];
  });
  let select: string[] | undefined;
  if (query.projection) {
    select = [];
    for (const name of query.projection) {
      fieldOf(collection, name);
      if (name !== key) {
        select.push(name);
      }
    }
  }
  return {
    filter: query.filter
      ? compileFilter(collection, query.filter, F)
      : undefined,
    orderBy,
    select,
  };
}
