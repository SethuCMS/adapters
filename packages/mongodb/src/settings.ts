/**
 * Parses and validates MongoDB connection settings from the generic
 * `ConnectInput` (config + credentials) handed over by the platform.
 */

import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';

/**
 * Validated, defaulted connection settings. Built only by {@link
 * parseSettings}.
 */
export interface MongoSettings {
  host: string;
  port: number;
  /** Use a mongodb+srv:// address (MongoDB Atlas). No port is used then. */
  srv: boolean;
  database: string;
  tls: boolean;
  authSource: string;
  maxConnections: number;
  statementTimeoutMs: number;
  sampleSize: number;
  user: string;
  password: string;
  /** Collection definitions declared by an administrator; they replace guessing from sample documents. */
  declared: unknown[];
}

// Strict allow-lists: host and db names end up in a connection
// URL, so anything outside these shapes is rejected up front.
const HOST = /^[A-Za-z0-9.\-_]{1,253}$/;
const DB_NAME = /^[A-Za-z_][A-Za-z0-9_\-]{0,62}$/;

/** Check connection settings. Messages say which setting is wrong and never include credential values. */
export function parseSettings(input: ConnectInput): MongoSettings {
  const { config, credentials } = input;
  const problems: string[] = [];

  const host = config['host'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    problems.push('host');
  }
  const srv = config['srv'] ?? false;
  if (typeof srv !== 'boolean') {
    problems.push('srv');
  }
  const port = config['port'] ?? 27017;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    problems.push('port');
  }
  const database = config['database'];
  if (typeof database !== 'string' || !DB_NAME.test(database)) {
    problems.push('database');
  }
  const tls = config['tls'] ?? true; // encrypted unless someone explicitly turns it off
  if (typeof tls !== 'boolean') {
    problems.push('tls');
  }
  const authSource = config['authSource'] ?? 'admin';
  if (typeof authSource !== 'string' || !DB_NAME.test(authSource)) {
    problems.push('authSource');
  }
  // Upper bounds on pool size, timeout and sample size stop a config from
  // exhausting the server or making introspection scan too much.
  const maxConnections = config['maxConnections'] ?? 5;
  if (
    typeof maxConnections !== 'number' ||
    !Number.isInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > 20
  ) {
    problems.push('maxConnections');
  }
  const statementTimeoutMs = config['statementTimeoutMs'] ?? 15_000;
  if (
    typeof statementTimeoutMs !== 'number' ||
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 100 ||
    statementTimeoutMs > 120_000
  ) {
    problems.push('statementTimeoutMs');
  }
  const sampleSize = config['sampleSize'] ?? 100;
  if (
    typeof sampleSize !== 'number' ||
    !Number.isInteger(sampleSize) ||
    sampleSize < 1 ||
    sampleSize > 1000
  ) {
    problems.push('sampleSize');
  }
  const declared = config['collections'] ?? [];
  if (!Array.isArray(declared) || declared.length > 500) {
    problems.push('collections');
  }

  const user = credentials['user'] ?? '';
  const password = credentials['password'] ?? '';
  if (typeof user !== 'string') {
    problems.push('credentials.user');
  }
  if (typeof password !== 'string') {
    problems.push('credentials.password');
  }

  if (problems.length > 0) {
    throw errors.validation(
      `Invalid MongoDB connection settings: ${problems.join(', ')}`,
    );
  }
  return {
    host: host as string,
    port: port as number,
    srv: srv as boolean,
    database: database as string,
    tls: tls as boolean,
    authSource: authSource as string,
    maxConnections: maxConnections as number,
    statementTimeoutMs: statementTimeoutMs as number,
    sampleSize: sampleSize as number,
    user: user as string,
    password: password as string,
    declared: declared as unknown[],
  };
}
