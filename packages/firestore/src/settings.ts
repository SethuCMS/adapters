/**
 * Parses and validates Firestore connection settings from the generic
 * `ConnectInput`, including the optional service-account credential.
 */

import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';

/**
 * Validated, defaulted Firestore connection settings, produced only by
 * {@link parseSettings}.
 */
export interface FirestoreSettings {
  projectId: string;
  databaseId: string;
  /** host:port of a Firestore emulator, for local development only. */
  emulatorHost: string | undefined;
  statementTimeoutMs: number;
  sampleSize: number;
  /** Most documents a text search may read. */
  maxScanDocuments: number;
  serviceAccount: { client_email: string; private_key: string } | undefined;
  declared: unknown[];
}

// Allow-lists mirroring Google's naming rules. The emulator host must be
// strictly `host:port` since it replaces the real endpoint.
const PROJECT = /^[a-z][a-z0-9\-]{4,28}[a-z0-9]$/;
const DATABASE = /^(\(default\)|[a-z][a-z0-9\-]{2,61}[a-z0-9])$/;
const EMULATOR = /^[A-Za-z0-9.\-_]{1,253}:\d{1,5}$/;

/** Check connection settings. Messages say which setting is wrong and never include credential values. */
export function parseSettings(input: ConnectInput): FirestoreSettings {
  const { config, credentials } = input;
  const problems: string[] = [];

  const projectId = config['projectId'];
  if (typeof projectId !== 'string' || !PROJECT.test(projectId)) {
    problems.push('projectId');
  }
  const databaseId = config['databaseId'] ?? '(default)';
  if (typeof databaseId !== 'string' || !DATABASE.test(databaseId)) {
    problems.push('databaseId');
  }
  const emulatorHost = config['emulatorHost'];
  if (
    emulatorHost !== undefined &&
    (typeof emulatorHost !== 'string' || !EMULATOR.test(emulatorHost))
  ) {
    problems.push('emulatorHost');
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
  // Cap for text-search scans (Firestore has no substring query, so we
  // read and filter locally); the bounds keep one request from reading a
  // huge collection.
  const maxScanDocuments = config['maxScanDocuments'] ?? 5000;
  if (
    typeof maxScanDocuments !== 'number' ||
    !Number.isInteger(maxScanDocuments) ||
    maxScanDocuments < 10 ||
    maxScanDocuments > 50_000
  ) {
    problems.push('maxScanDocuments');
  }
  const declared = config['collections'] ?? [];
  if (!Array.isArray(declared) || declared.length > 500) {
    problems.push('collections');
  }

  // The service account key (JSON text or an object). Without one, Google's default credentials are used.
  let serviceAccount: FirestoreSettings['serviceAccount'];
  let raw = credentials['serviceAccount'];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      problems.push('credentials.serviceAccount');
      raw = undefined;
    }
  }
  if (raw !== undefined && raw !== null) {
    const key = raw as { client_email?: unknown; private_key?: unknown };
    if (
      typeof key.client_email === 'string' &&
      typeof key.private_key === 'string'
    ) {
      serviceAccount = {
        client_email: key.client_email,
        private_key: key.private_key,
      };
    } else if (!problems.includes('credentials.serviceAccount')) {
      problems.push('credentials.serviceAccount');
    }
  }

  if (problems.length > 0) {
    throw errors.validation(
      `Invalid Firestore connection settings: ${problems.join(', ')}`,
    );
  }
  return {
    projectId: projectId as string,
    databaseId: databaseId as string,
    emulatorHost: emulatorHost as string | undefined,
    statementTimeoutMs: statementTimeoutMs as number,
    sampleSize: sampleSize as number,
    maxScanDocuments: maxScanDocuments as number,
    serviceAccount,
    declared: declared as unknown[],
  };
}
