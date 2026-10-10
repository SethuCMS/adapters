/**
 * Runs the shared conformance suite against the REAL Firestore emulator (Google's own, not our fake).
 *
 *   firebase emulators:start --only firestore          # listens on 127.0.0.1:8080 by default
 *   SETHUCMS_TEST_FIRESTORE_EMULATOR=127.0.0.1:8080 pnpm --filter @sethucms/adapter-firestore test
 *
 * Without that variable these tests are skipped. Every prepare() uses its own project id
 * ("demo-..."), and the emulator keeps data per project, so runs never see each other's data.
 * Needs @google-cloud/firestore installed (it is a dev dependency of this package).
 * Note: the emulator is not production Firestore. Indexes, quotas and some query limits differ.
 */
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import { FirestoreAdapter } from '../src/index.js';

const emulator = process.env['SETHUCMS_TEST_FIRESTORE_EMULATOR'];
const skip = emulator
  ? false
  : 'set SETHUCMS_TEST_FIRESTORE_EMULATOR (host:port) to run';
// Skipped, not failed, when no emulator is configured.
const liveTest = (name: string, run: () => Promise<void>) =>
  test(name, { skip }, run);

// `emulatorHost` switches the client to the local plain-text endpoint.
const connection = (projectId: string, readOnly: boolean) => ({
  connectionId: 'live',
  config: { projectId, emulatorHost: emulator },
  credentials: {},
  readOnly,
});

// Same conformance suite as the fake-based run, but against Google's real
// emulator, which catches fake/real divergences.
defineConformanceSuite(liveTest, {
  label: 'firestore (real emulator)',
  async prepare({ readOnly }) {
    const projectId = `demo-conf-${randomBytes(5).toString('hex')}`;
    const setup = new FirestoreAdapter();
    await setup.connect(connection(projectId, false));
    await setup.createCollection(conformanceCollection);
    await setup.close();
    const adapter = new FirestoreAdapter();
    await adapter.connect(connection(projectId, readOnly));
    return {
      adapter,
      cleanup: async () => {
        await adapter.close();
      },
    };
  },
});
