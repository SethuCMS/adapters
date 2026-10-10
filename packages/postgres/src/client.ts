/**
 * The small slice of a database client the adapter needs.
 *
 * Keeping it this narrow lets tests use a fake, and keeps the real driver
 * (`pg`) confined to one function.
 */
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';

/** Rows returned by one statement. */
export interface SqlResult {
  rows: Array<Record<string, unknown>>;
}

/** What the adapter needs from a database connection (pool). */
export interface SqlClient {
  /**
   * Run one statement. Values are always sent separately from the SQL text
   * (bound parameters), which is what prevents SQL injection.
   */
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  close(): Promise<void>;
}

/** Builds a client from connection input; tests supply a fake one. */
export type SqlClientFactory = (input: ConnectInput) => Promise<SqlClient>;

/**
 * Settings read from a connection's `config`. Secrets arrive separately as
 * `credentials`.
 */
export interface PostgresSettings {
  host: string;
  port: number;
  database: string;
  schema: string;
  ssl: boolean;
  maxConnections: number;
  statementTimeoutMs: number;
  user: string;
  password: string;
}

// Strict patterns, since these values end up in connection options and in
// quoted identifiers. IDENTIFIER matches sql-kit's identifier whitelist
// (63 chars is Postgres' name limit).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const HOST = /^[A-Za-z0-9.\-_:]{1,253}$/;

/**
 * Validate and default the connection settings. Messages name the offending
 * setting and never include credential values. All problems are reported at
 * once so the user can fix them in one pass.
 */
export function parseSettings(input: ConnectInput): PostgresSettings {
  const { config, credentials } = input;
  const problems: string[] = [];

  const host = config['host'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    problems.push('host');
  }

  const port = config['port'] ?? 5432;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    problems.push('port');
  }

  const database = config['database'];
  if (
    typeof database !== 'string' ||
    database.length === 0 ||
    database.length > 63
  ) {
    problems.push('database');
  }

  const schema = config['schema'] ?? 'public';
  if (typeof schema !== 'string' || !IDENTIFIER.test(schema)) {
    problems.push('schema');
  }

  // Encrypted unless someone explicitly turns it off (secure by default).
  const ssl = config['ssl'] ?? true;
  if (typeof ssl !== 'boolean') {
    problems.push('ssl');
  }

  // Capped at 20 so one connection cannot exhaust the server's slots.
  const maxConnections = config['maxConnections'] ?? 5;
  if (
    typeof maxConnections !== 'number' ||
    !Number.isInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > 20
  ) {
    problems.push('maxConnections');
  }

  // Bounded 0.1s-120s; the default 15s limits runaway queries.
  const statementTimeoutMs = config['statementTimeoutMs'] ?? 15_000;
  if (
    typeof statementTimeoutMs !== 'number' ||
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 100 ||
    statementTimeoutMs > 120_000
  ) {
    problems.push('statementTimeoutMs');
  }

  const user = credentials['user'];
  const password = credentials['password'];
  if (typeof user !== 'string' || user.length === 0) {
    problems.push('credentials.user');
  }
  if (typeof password !== 'string') {
    problems.push('credentials.password');
  }

  if (problems.length > 0) {
    throw errors.validation(
      `Invalid PostgreSQL connection settings: ${problems.join(', ')}`,
    );
  }

  return {
    host: host as string,
    port: port as number,
    database: database as string,
    schema: schema as string,
    ssl: ssl as boolean,
    maxConnections: maxConnections as number,
    statementTimeoutMs: statementTimeoutMs as number,
    user: user as string,
    password: password as string,
  };
}

/**
 * The real client, backed by the `pg` package (loaded on first use so that
 * importing this adapter does not require the driver until you connect).
 */
export const createPgClient: SqlClientFactory = async (input) => {
  const settings = parseSettings(input);

  let pg: any;
  try {
    // A variable name stops bundlers and TypeScript resolving `pg` statically,
    // keeping it an optional dependency.
    const moduleName = 'pg';
    pg = await import(moduleName);
  } catch {
    throw errors.internal('The "pg" package is not installed');
  }
  const { Pool } = pg.default ?? pg;

  // Session options sent with every connection. Read-only is enforced by the
  // database itself, on top of the guard layer, so a bug in either cannot
  // cause a write. Values are numbers/constants, never user text.
  const sessionOptions = [
    `-c statement_timeout=${settings.statementTimeoutMs}`,
  ];
  if (input.readOnly) {
    sessionOptions.push('-c default_transaction_read_only=on');
  }

  const pool = new Pool({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    max: settings.maxConnections,
    // Certificates are verified when TLS is on; `false` disables TLS entirely.
    ssl: settings.ssl ? { rejectUnauthorized: true } : false,
    options: sessionOptions.join(' '),
    connectionTimeoutMillis: 10_000,
  });
  // A broken idle connection must not crash the process.
  pool.on('error', () => undefined);

  return {
    async query(text, values) {
      const result = await pool.query(text, values);
      return { rows: result.rows as Array<Record<string, unknown>> };
    },
    async close() {
      await pool.end();
    },
  };
};
