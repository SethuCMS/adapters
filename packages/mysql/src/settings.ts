/**
 * Validation of MySQL / MariaDB connection settings. Kept apart from the
 * client so settings can be checked without loading the `mysql2` driver.
 */
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';

/** Validated, defaulted connection settings. */
export interface MysqlSettings {
  host: string;
  port: number;
  database: string;
  ssl: boolean;
  maxConnections: number;
  statementTimeoutMs: number;
  user: string;
  password: string;
}

// Hostnames/IPs only: no spaces, slashes or quotes, since the value goes
// straight to the driver.
const HOST = /^[A-Za-z0-9.\-_:]{1,253}$/;

/**
 * Validate and default the connection settings. Messages name the offending
 * setting and never include credential values. All problems are reported at
 * once so the user can fix them in one pass.
 */
export function parseSettings(input: ConnectInput): MysqlSettings {
  const { config, credentials } = input;
  const problems: string[] = [];

  const host = config['host'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    problems.push('host');
  }
  const port = config['port'] ?? 3306;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    problems.push('port');
  }
  // Same whitelist as quoted identifiers, as the name can be used in SQL.
  const database = config['database'];
  if (
    typeof database !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(database)
  ) {
    problems.push('database');
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
      `Invalid MySQL connection settings: ${problems.join(', ')}`,
    );
  }
  return {
    host: host as string,
    port: port as number,
    database: database as string,
    ssl: ssl as boolean,
    maxConnections: maxConnections as number,
    statementTimeoutMs: statementTimeoutMs as number,
    user: user as string,
    password: password as string,
  };
}
