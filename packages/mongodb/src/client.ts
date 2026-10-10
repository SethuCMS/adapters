/**
 * The real MongoDB client, backed by the official `mongodb` package (loaded on
 * first use). The address is built from validated parts, never taken from a
 * free-form connection string, so a setting cannot smuggle in driver options.
 */
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';
import { parseSettings } from './settings.js';

/** What the adapter uses from the driver. `any` keeps the driver an optional dependency. */
export interface MongoHandle {
  db: any;
  close(): Promise<void>;
  /** The driver module, for ObjectId and Binary. */
  driver: any;
}

/** Builds a connected {@link MongoHandle}. Tests inject a fake one. */
export type MongoClientFactory = (input: ConnectInput) => Promise<MongoHandle>;

/**
 * Default {@link MongoClientFactory}: connects with the real driver.
 * @throws internal error if the optional `mongodb` package is missing.
 */
export const createMongoClient: MongoClientFactory = async (input) => {
  const settings = parseSettings(input);

  let driver: any;
  try {
    // Dynamic import via a variable keeps bundlers and tsc from requiring
    // the driver at build time (it is an optional dependency).
    const moduleName = 'mongodb';
    driver = await import(moduleName);
    driver = driver.default?.MongoClient ? driver.default : driver;
  } catch {
    throw errors.internal('The "mongodb" package is not installed');
  }

  const login = settings.user
    ? `${encodeURIComponent(settings.user)}:${encodeURIComponent(settings.password)}@`
    : '';
  const address = settings.srv
    ? settings.host
    : `${settings.host}:${settings.port}`;
  const url = `${settings.srv ? 'mongodb+srv' : 'mongodb'}://${login}${address}/`;

  const client = new driver.MongoClient(url, {
    tls: settings.tls,
    authSource: settings.authSource,
    maxPoolSize: settings.maxConnections,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: settings.statementTimeoutMs + 5_000,
    retryWrites: false, // a retried write could run twice
    appName: 'sethucms',
  });
  // Swallow background errors: an unhandled "error" event would crash the
  // process. Real failures surface on the next operation and are mapped.
  client.on('error', () => undefined);
  await client.connect();
  return {
    db: client.db(settings.database),
    driver,
    close: () => client.close(),
  };
};
