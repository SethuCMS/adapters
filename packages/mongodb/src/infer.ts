/**
 * MongoDB has no schema, so the content model is guessed from a sample of
 * documents. The guess is deliberately conservative: a field whose values have
 * mixed kinds becomes `json` and is marked lossy, and nothing is "required".
 * An administrator can replace the guess with declared definitions, and
 * collections created by SethuCMS keep the definition they were created with.
 */
import {
  defineCollection,
  isSafeIdentifier,
  type CanonicalType,
  type CollectionDefinition,
  type FieldDefinition,
} from '@sethucms/core';

// A value kind seen in samples; `null` is tracked but ignored when typing
// so a missing/null value does not make a field look mixed.
type Kind = CanonicalType | 'null';

// Classify one sampled value. BSON wrappers are recognised by `_bsontype`
// rather than `instanceof` so no driver import is needed here.
function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return 'datetime';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'bigint') {
    return 'integer';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'decimal';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    const bson = (value as { _bsontype?: string })._bsontype;
    if (bson === 'ObjectId') {
      return 'string';
    }
    if (bson === 'Binary') {
      return 'binary';
    }
    if (bson === 'Long' || bson === 'Int32') {
      return 'integer';
    }
    if (bson === 'Double' || bson === 'Decimal128') {
      return 'decimal';
    }
    if (value instanceof Uint8Array) {
      return 'binary';
    }
    return 'json';
  }
  return 'json';
}

/**
 * Guess a {@link CollectionDefinition} from sample documents.
 * Returns `undefined` when the collection name is not a safe identifier,
 * so odd names are skipped rather than exposed. Fields with unsafe names
 * are dropped for the same reason.
 */
export function inferCollection(
  name: string,
  sample: Array<Record<string, unknown>>,
): CollectionDefinition | undefined {
  if (!isSafeIdentifier(name)) {
    return undefined;
  }

  const kinds = new Map<string, Set<Kind>>();
  for (const doc of sample) {
    for (const [field, value] of Object.entries(doc)) {
      if (!isSafeIdentifier(field)) {
        continue;
      }
      kinds.set(field, (kinds.get(field) ?? new Set()).add(kindOf(value)));
    }
  }

  // The key is `_id`, even when no document has been seen yet.
  // `_id` is hoisted out of the loop so it is always first and always the
  // primary key; only an all-integer `_id` is treated as integer.
  const idKinds = kinds.get('_id') ?? new Set<Kind>(['string']);
  const idType =
    idKinds.size === 1 && idKinds.has('integer') ? 'integer' : 'string';
  kinds.delete('_id');

  const fields: FieldDefinition[] = [
    {
      name: '_id',
      type: idType,
      primaryKey: true,
      generated: true,
      required: false,
      lossy: idKinds.size > 1,
    },
  ];
  for (const [field, seen] of kinds) {
    const present = [...seen].filter((kind) => kind !== 'null');
    let type: CanonicalType = 'json';
    let lossy = false;
    // One kind: use it. Integer+decimal merges to decimal (no loss). Any
    // other mix cannot be typed safely, so fall back to json and flag it
    // lossy.
    if (present.length === 1) {
      type = present[0] as CanonicalType;
    } else if (
      present.length === 2 &&
      present.includes('integer') &&
      present.includes('decimal')
    ) {
      type = 'decimal';
    } else if (present.length > 1) {
      lossy = true;
    } // mixed kinds: kept as json
    fields.push({
      name: field,
      type,
      primaryKey: false,
      generated: false,
      required: false,
      lossy,
    });
  }
  return defineCollection({ name, fields, relations: [] });
}
