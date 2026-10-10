/**
 * Firestore has no schema, so the content model is guessed from a sample of
 * documents (conservatively, like the MongoDB adapter). The document id is the
 * primary key and is called `id`.
 */
import {
  defineCollection,
  isSafeIdentifier,
  type CanonicalType,
  type CollectionDefinition,
  type FieldDefinition,
} from '@sethucms/core';

// Value kind seen in samples; `null` is ignored when typing a field.
type Kind = CanonicalType | 'null';

// Firestore wrappers (Timestamp, DocumentReference) are detected by shape
// (`toDate`, `path`) so no driver import is needed here.
function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'decimal';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Date) {
    return 'datetime';
  }
  if (value instanceof Uint8Array) {
    return 'binary';
  }
  if (typeof value === 'object') {
    const typed = value as { toDate?: unknown; path?: unknown };
    if (typeof typed.toDate === 'function') {
      return 'datetime';
    }
    if (typeof typed.path === 'string') {
      return 'string';
    }
  }
  return 'json';
}

/**
 * Guess a {@link CollectionDefinition} from sample documents. Returns
 * `undefined` for unsafe collection names; unsafe field names are skipped.
 * Mixed kinds fall back to `json` and are flagged `lossy`.
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
      // A stored field literally named `id` would clash with the synthetic key
      // (the document id), so it is hidden rather than shadowed.
      if (field === 'id' || !isSafeIdentifier(field)) {
        continue;
      }
      kinds.set(field, (kinds.get(field) ?? new Set()).add(kindOf(value)));
    }
  }
  const fields: FieldDefinition[] = [
    {
      name: 'id',
      type: 'string',
      primaryKey: true,
      generated: true,
      required: false,
      lossy: false,
    },
  ];
  for (const [field, seen] of kinds) {
    const present = [...seen].filter((kind) => kind !== 'null');
    let type: CanonicalType = 'json';
    let lossy = false;
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
    }
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
