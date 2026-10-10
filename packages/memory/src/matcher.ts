/**
 * Evaluating portable filters against plain JavaScript records.
 * This is the "native language" of the memory adapter.
 */
import type { Filter } from '@sethucms/core';
import type { RecordData } from '@sethucms/adapter-sdk';

/**
 * Compare two values of the same kind. Returns a negative, zero or positive
 * number. Mixed or non-primitive kinds fall back to comparing their string
 * forms, which is stable but not meaningful, so callers should compare like
 * with like.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  // Missing values (null/undefined) sort first, like NULLs in SQL.
  if (a === null || a === undefined) {
    return -1;
  }
  if (b === null || b === undefined) {
    return 1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b);
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// Equality used by eq/ne/in/nin: compareValues says 0. The extra check is a
// safety net so a missing value can never equal a present one. Note that
// null and undefined are equal only to themselves, not to each other.
function sameValue(a: unknown, b: unknown): boolean {
  return (
    compareValues(a, b) === 0 &&
    (a === null || a === undefined) === (b === null || b === undefined)
  );
}

// null and undefined both mean "no value" in a record.
function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Does this record satisfy the filter? A missing filter matches everything.
 * Mirrors the semantics the SQL adapters produce so all adapters agree.
 */
export function matches(
  record: RecordData,
  filter: Filter | undefined,
): boolean {
  if (!filter) {
    return true;
  }
  if ('and' in filter) {
    return filter.and.every((child) => matches(record, child));
  }
  if ('or' in filter) {
    return filter.or.some((child) => matches(record, child));
  }
  if ('not' in filter) {
    return !matches(record, filter.not);
  }

  const actual = record[filter.field];
  const expected = filter.value;

  switch (filter.op) {
    case 'eq':
      return sameValue(actual, expected);
    // Unlike SQL, a missing value counts as "not equal" to anything non-null,
    // matching the null-safe operators the SQL dialects use.
    case 'ne':
      return !sameValue(actual, expected);
    // Ordering comparisons never match a missing value (SQL: NULL < x is
    // unknown, which filters the row out).
    case 'lt':
      return !isMissing(actual) && compareValues(actual, expected) < 0;
    case 'lte':
      return !isMissing(actual) && compareValues(actual, expected) <= 0;
    case 'gt':
      return !isMissing(actual) && compareValues(actual, expected) > 0;
    case 'gte':
      return !isMissing(actual) && compareValues(actual, expected) >= 0;
    case 'in':
      return (expected as unknown[]).some((candidate) =>
        sameValue(actual, candidate),
      );
    case 'nin':
      return !(expected as unknown[]).some((candidate) =>
        sameValue(actual, candidate),
      );
    // On arrays: membership. On strings: case-insensitive substring (like the
    // SQL adapters' LIKE). Anything else never matches.
    case 'contains':
      if (Array.isArray(actual)) {
        return actual.some((item) => sameValue(item, expected));
      }
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    // Case-insensitive prefix, like the SQL adapters' LIKE 'x%'.
    case 'startsWith':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().startsWith(expected.toLowerCase())
      );
    case 'exists':
      return expected === false ? isMissing(actual) : !isMissing(actual);
  }
}
