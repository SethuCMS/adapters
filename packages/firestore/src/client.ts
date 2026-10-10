/**
 * The real Firestore client, backed by `@google-cloud/firestore` (loaded on
 * first use). It uses administrator credentials, so Firestore security rules do
 * not apply: the gateway's own permission engine is the only gate, which is why
 * a read-only connection should also use a read-only service account.
 */
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';
import { parseSettings } from './settings.js';

/**
 * What the adapter needs from the driver. `any` keeps the driver an optional
 * dependency.
 */
export interface FirestoreHandle {
  db: any;
  /** The driver's Filter class, used to build AND / OR conditions. */
  Filter: any;
  close(): Promise<void>;
}

/** Builds a connected {@link FirestoreHandle}. Tests inject a fake one. */
export type FirestoreClientFactory = (
  input: ConnectInput,
) => Promise<FirestoreHandle>;

/**
 * Default {@link FirestoreClientFactory}: connects with the real driver.
 * @throws internal error if `@google-cloud/firestore` is not installed.
 */
export const createFirestoreClient: FirestoreClientFactory = async (input) => {
  const settings = parseSettings(input);

  let driver: any;
  try {
    // Variable specifier: keeps the optional driver out of build-time
    // resolution.
    const moduleName = '@google-cloud/firestore';
    driver = await import(moduleName);
    driver = driver.default?.Firestore ? driver.default : driver;
  } catch {
    throw errors.internal(
      'The "@google-cloud/firestore" package is not installed',
    );
  }

  const options: Record<string, unknown> = {
    projectId: settings.projectId,
    databaseId: settings.databaseId,
    // Strict on purpose: an `undefined` should be a bug we hear about, not a
    // silently dropped field.
    ignoreUndefinedProperties: false,
  };
  if (settings.emulatorHost) {
    // Emulator mode: plain-text local endpoint. The "owner" bearer token is
    // the emulator's way of bypassing security rules.
    options['host'] = settings.emulatorHost;
    options['ssl'] = false;
    options['customHeaders'] = { Authorization: 'Bearer owner' };
  } else if (settings.serviceAccount) {
    options['credentials'] = settings.serviceAccount;
  }
  const db = new driver.Firestore(options);
  return { db, Filter: driver.Filter, close: () => db.terminate() };
};
