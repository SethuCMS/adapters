/**
 * Helpers shared by the introspection code of the SQL adapters.
 */
import { defineCollection, type CollectionDefinition } from '@sethucms/core';

/**
 * Remove relations whose target collection (or target columns) is missing.
 *
 * Introspection skips tables it cannot model, so a foreign key may point at
 * something that never made it into the content model. Keeping it would make
 * the whole model invalid; dropping it keeps the rest usable. Collections
 * without broken relations are returned as-is (same object).
 */
export function dropBrokenRelations(
  collections: CollectionDefinition[],
): CollectionDefinition[] {
  const byName = new Map(
    collections.map((collection) => [collection.name, collection]),
  );

  return collections.map((collection) => {
    const valid = collection.relations.filter((relation) => {
      const target = byName.get(relation.target);
      return (
        target &&
        Object.values(relation.mapping).every((name) =>
          target.fields.some((field) => field.name === name),
        )
      );
    });
    return valid.length === collection.relations.length
      ? collection
      : defineCollection({
          name: collection.name,
          fields: [...collection.fields],
          relations: valid,
        });
  });
}
