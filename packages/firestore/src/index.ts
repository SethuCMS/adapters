/**
 * Public entry point of the Firestore adapter package: re-exports the adapter,
 * client factory, settings parser, inference and query translators.
 */

export * from './firestore-adapter.js';
export {
  createFirestoreClient,
  type FirestoreClientFactory,
  type FirestoreHandle,
} from './client.js';
export { parseSettings, type FirestoreSettings } from './settings.js';
export { inferCollection } from './infer.js';
export {
  compileFilter,
  compileFind,
  assertValidDocumentId,
  assertStorable,
} from './translate.js';
export { mapFirestoreError } from './errors.js';
