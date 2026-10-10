/**
 * Discovering tables and columns from PostgreSQL's catalog
 * (information_schema).
 *
 * The result becomes the allowlist of names the platform accepts, so anything
 * unusual is left out rather than guessed at:
 *   - tables or columns whose names are not plain identifiers
 *   - tables without a primary key, or with a composite one
 */
import {
  defineCollection,
  isSafeIdentifier,
  type CollectionDefinition,
  type FieldDefinition,
  type RelationDefinition,
} from '@sethucms/core';
import type { SqlClient } from './client.js';
import { mapPgType } from './type-map.js';

// Row shapes of the three catalog queries below (column names match SQL).
interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  is_generated: string;
}
interface KeyRow {
  table_name: string;
  column_name: string;
}
interface ForeignKeyRow extends KeyRow {
  target_table: string;
  target_column: string;
  constraint_name: string;
}

// Only BASE TABLEs: the join drops views, which have no key and cannot be
// written. The schema is a bound parameter, never spliced into the text.
const COLUMNS_SQL = `
  SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, c.is_identity, c.is_generated
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = $1
  ORDER BY c.table_name, c.ordinal_position`;

// Constraint names are only unique per schema/table, so the join also matches
// on schema and table to avoid mixing up same-named constraints.
const PRIMARY_KEYS_SQL = `
  SELECT kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema AND kcu.table_name = tc.table_name
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`;

// constraint_column_usage reports the *referenced* table and column. It lists
// columns of the target only, so composite keys produce one row per column.
const FOREIGN_KEYS_SQL = `
  SELECT kcu.table_name, kcu.column_name, ccu.table_name AS target_table, ccu.column_name AS target_column, tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema AND kcu.table_name = tc.table_name
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`;

/** Group rows by table name. */
function groupByTable<T extends { table_name: string }>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    groups.set(row.table_name, [...(groups.get(row.table_name) ?? []), row]);
  }
  return groups;
}

/**
 * Does the database fill this column in by itself (serial, identity,
 * generated)? Old-style `serial` has no flag; it is detected by its
 * `nextval(...)` default.
 */
function isDatabaseGenerated(row: ColumnRow): boolean {
  return (
    row.is_identity === 'YES' ||
    row.is_generated === 'ALWAYS' ||
    (row.column_default ?? '').startsWith('nextval(')
  );
}

/**
 * Read one schema's tables and turn them into collection definitions.
 *
 * Tables are skipped (not failed) when they cannot be modelled safely, so a
 * messy database still yields a usable, conservative model.
 */
export async function introspectSchema(
  client: SqlClient,
  schema: string,
): Promise<CollectionDefinition[]> {
  // Three independent catalog reads, so run them concurrently.
  const [columns, primaryKeys, foreignKeys] = await Promise.all([
    client.query(COLUMNS_SQL, [schema]),
    client.query(PRIMARY_KEYS_SQL, [schema]),
    client.query(FOREIGN_KEYS_SQL, [schema]),
  ]);

  const columnsByTable = groupByTable(columns.rows as unknown as ColumnRow[]);
  const keysByTable = groupByTable(primaryKeys.rows as unknown as KeyRow[]);
  const foreignKeysByTable = groupByTable(
    foreignKeys.rows as unknown as ForeignKeyRow[],
  );

  const collections: CollectionDefinition[] = [];

  for (const [table, columnRows] of columnsByTable) {
    if (!isSafeIdentifier(table)) {
      continue;
    }

    // Exactly one key column: composite keys cannot be addressed by one id.
    const keys = keysByTable.get(table) ?? [];
    const [key] = keys;
    if (keys.length !== 1 || !key || !isSafeIdentifier(key.column_name)) {
      continue;
    }

    const fields: FieldDefinition[] = [];
    for (const column of columnRows) {
      if (!isSafeIdentifier(column.column_name)) {
        continue;
      }

      const mapped = mapPgType(column.data_type);
      const generated = isDatabaseGenerated(column);
      const isKey = column.column_name === key.column_name;

      fields.push({
        name: column.column_name,
        type: mapped.type,
        primaryKey: isKey,
        generated,
        // Required means the caller must supply it: NOT NULL, no default, and
        // not filled in by the database.
        required:
          column.is_nullable === 'NO' &&
          column.column_default === null &&
          !generated,
        lossy: mapped.lossy,
      });
    }
    if (!fields.some((field) => field.primaryKey)) {
      continue;
    }

    // Each single-column foreign key becomes a many-to-one relation.
    const relations: RelationDefinition[] = (
      foreignKeysByTable.get(table) ?? []
    )
      .filter(
        (fk) =>
          isSafeIdentifier(fk.target_table) &&
          isSafeIdentifier(fk.target_column) &&
          fields.some((f) => f.name === fk.column_name),
      )
      .map((fk) => ({
        name: `${fk.column_name}_ref`,
        target: fk.target_table,
        kind: 'many_to_one' as const,
        mapping: { [fk.column_name]: fk.target_column },
      }));

    collections.push(defineCollection({ name: table, fields, relations }));
  }

  return dropBrokenRelations(collections);
}

/**
 * Drop relations whose target table or columns were skipped above, since a
 * dangling relation would make the content model invalid. (Same logic as the
 * sql-kit helper of the same name.)
 */
function dropBrokenRelations(
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
