/**
 * The real MySQL / MariaDB client, backed by the `mysql2` package (loaded on
 * first use). Statements are sent as real prepared statements, so values are
 * never part of the SQL text.
 */
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';
import type { SqlClient } from '@sethucms/adapter-sql-kit';
import { parseSettings } from './settings.js';

/** Builds a client from connection input; tests supply a fake one. */
export type SqlClientFactory = (input: ConnectInput) => Promise<SqlClient>;

/**
 * Open a connection pool and wrap it as a SqlClient. Session settings make
 * the database itself enforce strictness and read-only mode.
 */
export const createMysqlClient: SqlClientFactory = async (input) => {
  const settings = parseSettings(input);

  let mysql: any;
  try {
    // A variable name keeps `mysql2` an optional, lazily loaded dependency.
    const moduleName = 'mysql2/promise';
    mysql = await import(moduleName);
  } catch {
    throw errors.internal('The "mysql2" package is not installed');
  }
  const { createPool } = mysql.default ?? mysql;

  const pool = createPool({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    connectionLimit: settings.maxConnections,
    ssl: settings.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 10_000,
    // Dates are stored and read as UTC.
    timezone: 'Z',
    // Integers too big for a JS number come back as text, never rounded.
    // sql-kit turns them back into numbers only when that is exact.
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    // JSON arrives as text; sql-kit parses it the same way for every database.
    jsonStrings: true,
    // One statement per call, always: stops stacked-query injection.
    multipleStatements: false,
    // UPDATE reports rows matched, not only rows changed, so an update that
    // sets identical values is not mistaken for a missing record.
    flags: ['+FOUND_ROWS'],
  });
  pool.on('connection', (connection: any) => {
    // Strict mode makes the database refuse bad values instead of silently
    // truncating or changing them. Runs on every new pooled connection.
    connection.query(
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE'",
    );
    // Read-only is enforced by the database itself, on top of the guard layer.
    if (input.readOnly) {
      connection.query('SET SESSION TRANSACTION READ ONLY');
    }
  });

  return {
    async query(text, values) {
      // execute() uses a real prepared statement: values are sent apart from
      // the text. The timeout is enforced per statement by the driver.
      const [result] = await pool.execute(
        { sql: text, timeout: settings.statementTimeoutMs },
        (values ?? []) as unknown[],
      );
      // A SELECT returns an array of rows; anything else is a write header.
      if (Array.isArray(result)) {
        return {
          rows: (result as Array<Record<string, unknown>>).map((row) => ({
            ...row,
          })),
        };
      }
      // Writes carry no rows: surface the generated key and matched-row count.
      const header = result as {
        insertId?: number | string | bigint;
        affectedRows?: number;
      };
      return {
        rows: [],
        // insertId is 0 when no AUTO_INCREMENT key was generated; omit it then.
        ...(header.insertId !== undefined && Number(header.insertId) !== 0
          ? {
              insertId:
                // Keep bigint keys exact as text.
                typeof header.insertId === 'bigint'
                  ? header.insertId.toString()
                  : header.insertId,
            }
          : {}),
        ...(header.affectedRows !== undefined
          ? { affected: header.affectedRows }
          : {}),
      };
    },
    async close() {
      await pool.end();
    },
  };
};
