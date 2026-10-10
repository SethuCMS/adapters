/**
 * Discovering tables and columns from a SQLite file.
 *
 * As with the other SQL adapters, anything unusual is left out rather than
 * guessed at: unsafe names, tables without exactly one primary key column,
 * and virtual tables.
 */
import {
  defineCollection,
  isSafeIdentifier,
  type CollectionDefinition,
  type FieldDefinition,
  type RelationDefinition,
} from '@sethucms/core';
import { dropBrokenRelations, type SqlClient } from '@sethucms/adapter-sql-kit';
import { mapSqliteType } from './type-map.js';

// Row shapes of the pragma queries below (column names match SQLite's).
interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}
interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

/**
 * Read the database's tables and turn them into collection definitions.
 * Tables that cannot be modelled safely are skipped, not failed.
 */
export async function introspectSchema(
  client: SqlClient,
): Promise<CollectionDefinition[]> {
  // Skip SQLite's internal tables (the LIKE escapes the underscore so only
  // names starting "sqlite_" match) and virtual tables, which cannot be
  // written like normal ones.
  const tables = await client.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`,
  );

  const info = new Map<
    string,
    { columns: ColumnRow[]; foreign: ForeignKeyRow[] }
  >();
  for (const { name } of tables.rows as Array<{ name: string }>) {
    if (!isSafeIdentifier(name)) {
      continue;
    }
    // The table name is bound as a parameter to the table-valued pragma
    // functions, so it never enters the SQL text. table_xinfo (not table_info)
    // also reports hidden/generated columns.
    const columns = await client.query(
      'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)',
      [name],
    );
    const foreign = await client.query(
      'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?)',
      [name],
    );
    info.set(name, {
      columns: columns.rows as unknown as ColumnRow[],
      foreign: foreign.rows as unknown as ForeignKeyRow[],
    });
  }

  const collections: CollectionDefinition[] = [];
  const keyOf = new Map<string, string>();

  for (const [table, { columns }] of info) {
    // pk > 0 marks key columns; more than one means a composite key.
    const keys = columns.filter((column) => column.pk > 0);
    const [key] = keys;
    if (keys.length !== 1 || !key || !isSafeIdentifier(key.name)) {
      continue;
    }
    keyOf.set(table, key.name);

    const fields: FieldDefinition[] = [];
    for (const column of columns) {
      // hidden = 1 is a column of a virtual table; skip it (and unsafe names).
      if (column.hidden === 1 || !isSafeIdentifier(column.name)) {
        continue;
      }
      const mapped = mapSqliteType(column.type);
      const isKey = column.name === key.name;
      // Exactly "INTEGER PRIMARY KEY" aliases the row id, so SQLite fills it
      // in. hidden >= 2 marks generated columns. Other key types are not.
      const generated =
        column.hidden >= 2 ||
        (isKey && column.type.trim().toUpperCase() === 'INTEGER');
      fields.push({
        name: column.name,
        type: mapped.type,
        primaryKey: isKey,
        generated,
        required:
          column.notnull === 1 && column.dflt_value === null && !generated,
        lossy: mapped.lossy,
      });
    }

    collections.push(defineCollection({ name: table, fields, relations: [] }));
  }

  // Foreign keys, once every table's key is known (a key may be implicit:
  // "REFERENCES parent" with no column names the parent's primary key).
  const withRelations = collections.map((collection) => {
    // One row per column; rows sharing an `id` belong to one constraint.
    const groups = new Map<number, ForeignKeyRow[]>();
    for (const row of info.get(collection.name)?.foreign ?? []) {
      groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    }
    const relations: RelationDefinition[] = [];
    for (const rows of groups.values()) {
      const [fk] = rows;
      // Composite foreign keys are not supported by single-column relations.
      if (rows.length !== 1 || !fk) {
        continue;
      }
      const targetKey = fk.to ?? keyOf.get(fk.table);
      if (
        !targetKey ||
        !isSafeIdentifier(fk.table) ||
        !isSafeIdentifier(targetKey) ||
        !collection.fields.some((f) => f.name === fk.from)
      ) {
        continue;
      }
      relations.push({
        name: `${fk.from}_ref`,
        target: fk.table,
        kind: 'many_to_one',
        mapping: { [fk.from]: targetKey },
      });
    }
    return relations.length
      ? defineCollection({
          name: collection.name,
          fields: [...collection.fields],
          relations,
        })
      : collection;
  });

  // Drop relations whose target table or column was skipped above.
  return dropBrokenRelations(withRelations);
}
