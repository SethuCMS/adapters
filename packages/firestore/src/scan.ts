/**
 * Text search for Firestore.
 *
 * Firestore cannot search inside text, so a query that does ("contains" on a
 * text field) is answered by reading the collection and filtering here. The
 * answer is exact, but it reads every document, so it is capped: past the cap
 * the query is refused rather than made slow or expensive without warning.
 *
 * Rules match the SQL adapters: "contains" ignores case, null never satisfies a
 * comparison, "ne" is true for null, and "not" of an unknown counts as a match.
 */
import {
  primaryKeyOf,
  type CollectionDefinition,
  type Filter,
  type Query,
} from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';
import { inequalityFields, negate, storedName } from './translate.js';

export function needsScan(
  collection: CollectionDefinition,
  filter: Filter | undefined,
): boolean {
  if (!filter) {
    return false;
  }
  if ('and' in filter) {
    return filter.and.some((child) => needsScan(collection, child));
  }
  if ('or' in filter) {
    return filter.or.some((child) => needsScan(collection, child));
  }
  if ('not' in filter) {
    // NOT is pushed down to the comparisons, so judge the filter the database would really get.
    let pushed: Filter | undefined;
    try {
      pushed = negate(filter.not);
    } catch {
      pushed = undefined;
    }
    return needsScan(collection, pushed ?? filter.not);
  }
  if (filter.op === 'contains') {
    return (
      collection.fields.find((field) => field.name === filter.field)?.type !==
      'array'
    );
  }
  // Firestore rejects the OR (not-equal) and the AND/OR (not-in) that "null-safe" matching needs,
  // so those are answered by reading the collection, exactly as the SQL adapters would.
  if (filter.op === 'ne') {
    return filter.value !== null;
  }
  if (filter.op === 'nin') {
    return (filter.value as unknown[]).some((item) => item !== null);
  }
  return false;
}

/**
 * Answer by scanning when Firestore cannot run the query as written: text search, null-safe
 * not-equal, or an inequality filter combined with a sort on a different field (or several
 * inequality fields), which Firestore refuses.
 */
export function mustScan(
  collection: CollectionDefinition,
  query: Query,
): boolean {
  if (needsScan(collection, query.filter)) {
    return true;
  }
  const ranged = inequalityFields(collection, query.filter);
  if (ranged.length === 0) {
    return false;
  }
  if (ranged.length > 1) {
    return true;
  }
  const first = query.sort?.[0];
  return (
    first !== undefined && storedName(collection, first.field) !== ranged[0]
  );
}

function compare(a: unknown, b: unknown): number {
  const x = a as number | string | boolean;
  const y = b as number | string | boolean;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matchesFilter(filter: Filter, record: RecordData): boolean {
  if ('and' in filter) {
    return filter.and.every((child) => matchesFilter(child, record));
  }
  if ('or' in filter) {
    return filter.or.some((child) => matchesFilter(child, record));
  }
  if ('not' in filter) {
    return !matchesFilter(filter.not, record);
  }

  const value = record[filter.field] ?? null;
  const target = filter.value;
  const comparable =
    value !== null && target !== null && typeof value === typeof target;

  switch (filter.op) {
    case 'eq':
      return value === target;
    case 'ne':
      return value !== target;
    case 'lt':
      return comparable && compare(value, target) < 0;
    case 'lte':
      return comparable && compare(value, target) <= 0;
    case 'gt':
      return comparable && compare(value, target) > 0;
    case 'gte':
      return comparable && compare(value, target) >= 0;
    case 'in':
      return (target as unknown[]).includes(value);
    case 'nin':
      return !(target as unknown[]).includes(value);
    case 'contains':
      if (Array.isArray(value)) {
        return value.includes(target);
      }
      return (
        typeof value === 'string' &&
        value.toLowerCase().includes(String(target).toLowerCase())
      );
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(String(target)); // case-sensitive, like Firestore itself
    case 'exists':
      return target === false ? value === null : value !== null;
  }
}

/** Sort like the SQL adapters: nulls first when ascending, then by the key so pages never overlap. */
export function sortRecords(
  collection: CollectionDefinition,
  query: Query,
  records: RecordData[],
): RecordData[] {
  const key = primaryKeyOf(collection).name;
  const sorts = [...(query.sort ?? [])];
  if (!sorts.some((sort) => sort.field === key)) {
    sorts.push({ field: key, dir: 'asc' });
  }
  return [...records].sort((a, b) => {
    for (const { field, dir } of sorts) {
      const x = a[field] ?? null;
      const y = b[field] ?? null;
      const c =
        x === null && y === null
          ? 0
          : x === null
            ? -1
            : y === null
              ? 1
              : compare(x, y);
      if (c !== 0) {
        return dir === 'desc' ? -c : c;
      }
    }
    return 0;
  });
}
