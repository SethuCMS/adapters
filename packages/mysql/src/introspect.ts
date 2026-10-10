/**
 * Discovering tables and columns from MySQL / MariaDB's information_schema.
 * Unusual things are left out rather than guessed at: unsafe names, tables
 * without exactly one primary key column, and views.
 */
import {
  defineCollection,
  isSafeIdentifier,
  type CollectionDefinition,
  type FieldDefinition,
  type RelationDefinition,
} from '@sethucms/core';
import { dropBrokenRelations, type SqlClient } from '@sethucms/adapter-sql-kit';
import { mapMysqlType } from './type-map.js';

// Row shapes of the catalog queries below (aliased to these names).
interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  column_type: string;
  is_nullable: string;
  column_default: string | null;
  extra: string;
  column_key: string;
}
interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
}

// Aliases are lowercase because MySQL 8 returns information_schema column
// names in upper case, which would otherwise differ between servers.
// DATABASE() scopes to the connection's database; no name is spliced in.
const COLUMNS_SQL = `
  SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.COLUMN_TYPE AS column_type,
         c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.EXTRA AS extra, c.COLUMN_KEY AS column_key
  FROM information_schema.COLUMNS c
  JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
  WHERE c.TABLE_SCHEMA = DATABASE()
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

// Rows with a non-NULL REFERENCED_TABLE_NAME are foreign keys. A composite
// key yields several rows sharing one CONSTRAINT_NAME (handled below).
const FOREIGN_KEYS_SQL = `
  SELECT k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS target_table,
         k.REFERENCED_COLUMN_NAME AS target_column, k.CONSTRAINT_NAME AS constraint_name
  FROM information_schema.KEY_COLUMN_USAGE k
  WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`;

// MariaDB has no real JSON type: "JSON" is LONGTEXT plus a
// json_valid(`column`) check constraint. Find those columns so they are
// treated as JSON. MySQL has a real JSON type and no TABLE_NAME in this view,
// so the query is allowed to fail there. The LIKE is only a cheap prefilter
// (underscore escaped so it matches literally); the exact shape is checked
// in code below.
const JSON_CHECKS_SQL = `
  SELECT TABLE_NAME AS table_name, CHECK_CLAUSE AS check_clause
  FROM information_schema.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND LOWER(CHECK_CLAUSE) LIKE '%json\\_valid(%'`;

// Returns "table.column" keys for MariaDB columns that are really JSON.
async function mariadbJsonColumns(client: SqlClient): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    const { rows } = await client.query(JSON_CHECKS_SQL);
    for (const row of rows as unknown as Array<{
      table_name: string;
      check_clause: string;
    }>) {
      // Accept only the exact `json_valid(`col`)` form, so a more complex check
      // (which might not mean "this is JSON") is not misread as JSON.
      const match = /^\s*json_valid\(\s*`([^`]+)`\s*\)\s*$/i.exec(
        row.check_clause,
      );
      if (match) {
        found.add(`${row.table_name}.${match[1]}`);
      }
    }
  } catch {
    // Not MariaDB, or an old server: nothing to add. Never fatal.
  }
  return found;
}

/**
 * Read the connected database's tables and turn them into collection
 * definitions. Tables that cannot be modelled safely are skipped, not failed.
 */
export async function introspectSchema(
  client: SqlClient,
): Promise<CollectionDefinition[]> {
  // Independent reads, run concurrently.
  const [columns, foreignKeys, jsonColumns] = await Promise.all([
    client.query(COLUMNS_SQL),
    client.query(FOREIGN_KEYS_SQL),
    mariadbJsonColumns(client),
  ]);

  const byTable = new Map<string, ColumnRow[]>();
  for (const row of columns.rows as unknown as ColumnRow[]) {
    byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row]);
  }

  const fkByTable = new Map<string, ForeignKeyRow[]>();
  for (const row of foreignKeys.rows as unknown as ForeignKeyRow[]) {
    fkByTable.set(row.table_name, [
      ...(fkByTable.get(row.table_name) ?? []),
      row,
    ]);
  }

  const collections: CollectionDefinition[] = [];
  for (const [table, rows] of byTable) {
    if (!isSafeIdentifier(table)) {
      continue;
    }
    // Exactly one PRI column: composite keys cannot be addressed by one id.
    const keys = rows.filter((row) => row.column_key === 'PRI');
    const [key] = keys;
    if (keys.length !== 1 || !key || !isSafeIdentifier(key.column_name)) {
      continue;
    }

    const fields: FieldDefinition[] = [];
    for (const column of rows) {
      if (!isSafeIdentifier(column.column_name)) {
        continue;
      }
      // Only LONGTEXT can be MariaDB's JSON stand-in; a json_valid check on
      // any other type is left as it is.
      const isJson =
        jsonColumns.has(`${table}.${column.column_name}`) &&
        column.data_type.toLowerCase() === 'longtext';
      const mapped = isJson
        ? { type: 'json' as const, lossy: false }
        : mapMysqlType(column.data_type, column.column_type);
      const extra = (column.extra ?? '').toLowerCase();
      // AUTO_INCREMENT and generated columns are filled in by the database.
      const generated =
        extra.includes('auto_increment') || extra.includes('generated');
      fields.push({
        name: column.column_name,
        type: mapped.type,
        primaryKey: column.column_name === key.column_name,
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

    const relations: RelationDefinition[] = (fkByTable.get(table) ?? [])
      .filter(
        (fk) =>
          isSafeIdentifier(fk.target_table) &&
          isSafeIdentifier(fk.target_column) &&
          fields.some((f) => f.name === fk.column_name),
      )
      // Composite foreign keys (several rows with one constraint name) are not
      // supported by single-column relations, so they are dropped.
      .filter(
        (fk, _i, all) =>
          all.filter((other) => other.constraint_name === fk.constraint_name)
            .length === 1,
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
